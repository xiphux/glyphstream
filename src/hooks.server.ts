import type { Handle, HandleServerError } from '@sveltejs/kit/hooks';
import process from 'node:process';

import {
	readSessionCookie,
	setSessionCookie,
	setSessionUnlockedUntil,
	validateSessionToken,
} from '#lib/server/auth/session.js';
import {
	evaluateAppLock,
	readInstalledAppCookie,
	type AppLockState,
} from '#lib/server/auth/app-lock.js';
import { APP_LOCK_KEEPALIVE_PATH } from '#lib/app-lock.js';
import { maybeCompressResponse, maybeCompressStream } from '#lib/server/compression.js';
import { STREAM_GZIP_COOKIE, STREAM_PROBE_PATH } from '#lib/stream-probe.js';
import { applySecurityHeaders } from '#lib/server/security-headers.js';
import { consumeRateLimitToken } from '#lib/server/rate-limit.js';
import { routedPathname } from '#lib/server/util/request-path.js';
import { chainHandles } from '#lib/server/util/handle-chain.js';
import {
	compressDynamicResponses,
	compressStreamingResponses,
	passkeyLoginEnabled,
	publicBaseUrl,
	validateAuthMethodsEnabled,
	validateSecrets,
} from '#lib/server/env.js';
import { ensureAdminBootstrap } from '#lib/server/db/queries/users.js';
import { startMediaPurger, stopMediaPurger } from '#lib/server/media/purger.js';
import { startSessionSweeper, stopSessionSweeper } from '#lib/server/auth/session-sweeper.js';
import { probeMediaDirsWritable } from '#lib/server/media/writable-probe.js';
import {
	startDimensionsBackfiller,
	stopDimensionsBackfiller,
} from '#lib/server/media/dimensions-backfill.js';
import {
	startEmbeddingBackfiller,
	stopEmbeddingBackfiller,
} from '#lib/server/memory/embedding-backfill.js';
import { startTopicBackfiller, stopTopicBackfiller } from '#lib/server/memory/topic-backfill.js';
import { startDreamingWorker, stopDreamingWorker } from '#lib/server/memory/dreaming.js';
import { startScheduledTaskRunner, stopScheduledTaskRunner } from '#lib/server/scheduled/runner.js';
import {
	startConversationSummaryWorker,
	stopConversationSummaryWorker,
} from '#lib/server/memory/conversation-summary.js';
import { bootstrapMcp } from '#lib/server/mcp/bootstrap.js';
import { listAllModels } from '#lib/server/endpoints/list-models.js';
import { installPersistedPauses } from '#lib/server/endpoints/pause.js';
import {
	drainEndpointGates,
	setResourceGroupMembersSource,
} from '#lib/server/endpoints/concurrency.js';
import { listEndpoints } from '#lib/server/endpoints/registry.js';
import {
	resumeGenerationJobs,
	scheduleGenerationJobResume,
	stopGenerationJobResume,
} from '#lib/server/generation/jobs.js';
import { stopMcp } from '#lib/server/mcp/registry.js';
import { stopPool } from '#lib/server/code-interpreter/pool.js';
import { maxLoopLagSince, startLoopLagSampler } from '#lib/server/util/loop-lag.js';
import { swapBytes } from '#lib/server/util/proc-swap.js';
import { dbFileBytes, mmapBytes } from '#lib/server/db/client.js';
import {
	HEADER_BUDGET_RESERVE_BYTES,
	PROXY_HEADER_BUFFER_BYTES,
	TRANSPORT_OVERHEAD_BYTES,
	headerBlockBytes,
	trimToBudget,
} from '#lib/server/util/header-budget.js';
import { createLogger } from '#lib/server/log.js';

const authLog = createLogger('auth');
const serverErrorLog = createLogger('server error');
const shutdownLog = createLogger('shutdown');

// Refuse to start if the auth-method toggles leave no way in. Better to
// crash at boot with a clear message than serve a /login page with zero
// buttons. Also catches the "passkeys on but EXTERNAL_BASE_URL not set in
// prod" misconfig, since the RP ID is derived from it.
// Same for a missing or short AUTH_SECRET (or MCP_SECRET_KEY, when set).
validateSecrets();
validateAuthMethodsEnabled();

// Upgrade recovery (single-user → multi-user): a pre-multi-user DB gets the
// new `role` column defaulted to 'user' and therefore zero admins, with
// /setup already closed — so we promote the original operator. Run ONCE,
// lazily, on the first authenticated request (see `session`) rather than at
// module load: it must not open the DB at boot, both to avoid doing DB work
// before the connection is needed and so the e2e harness (which wipes +
// recreates the DB in global-setup) can't race a boot-time connection.
let adminBootstrapChecked = false;

// Resolve the COMPRESS_DYNAMIC env var once at module load — there's no
// reason to re-read on every request, and a deploy that flips it
// restarts the process anyway.
const SHOULD_COMPRESS_DYNAMIC = compressDynamicResponses();
const SHOULD_COMPRESS_STREAMS = compressStreamingResponses();

// Endpoint pauses live in the database so they survive a restart; point the
// concurrency gate at them before anything can acquire a slot. Opens nothing
// yet — the set is read on the first gate created.
installPersistedPauses();
// A new gate, or a resumed one, presumes a group member that can release still
// has its model resident — this process can't know what survived the restart or
// what loaded while paused. Read lazily, like the pauses.
setResourceGroupMembersSource(listEndpoints);

// Image / video generations are durable jobs; whatever was queued or running
// when the last process stopped goes back in line. Resumed by the first
// signed-in request (see `session`), or by this timer for a server nobody is
// visiting — never at module load, for the same reason the admin bootstrap
// isn't (below).
scheduleGenerationJobResume();

// Say so at boot if the media or derived directory isn't writable — a mount
// left root-owned by an older root-run image otherwise fails per request with
// no explanation. Logs only; never blocks startup.
void probeMediaDirsWritable();

// Start the media purge sweeper at module load — runs once per Node process.
// Using top-level rather than the first-request handler so the sweep clock
// starts even if no user has hit the server yet (e.g. on a fresh redeploy).
startMediaPurger();

// Delete expired sessions — nothing else ever removes a session whose token is
// never presented again. Same boot-time rationale as the purger.
startSessionSweeper();

// Backfill embeddings for saved memories + gallery prompts (recall_memory and
// semantic gallery search). No-op when no `[embeddings]` block is configured.
// Same boot-time rationale as the purger.
startEmbeddingBackfiller();

// Backfill topic labels for saved memories created before the `topic` field
// (the over-budget index shows a content snippet until then). Uses the task
// model; no-op when no `task_model` is configured, and self-stops once the
// historical backlog is drained.
startTopicBackfiller();

// Record the pixel size of images stored before `media.width`/`height` existed
// (every insert measures its own now). Self-stops once that backlog is drained.
startDimensionsBackfiller();

// Memory consolidation ("dreaming"): during a configured quiet-hours window, a
// capable memory model merges/rewords/prunes each user's saved memories (with
// soft-delete reversibility). No-op when no `[memory_model]` block is configured.
startDreamingWorker();

// Per-conversation summaries + the orientation overview: during the same
// quiet-hours window, the memory model writes a short gist per settled
// conversation (indexed into search so `search_conversations` surfaces threads by
// meaning) and rebuilds each user's bounded "topics we've discussed" overview
// (injected into the persona prompt). No-op without a `[memory_model]` block.
// Separate worker from dreaming; the shared endpoint slot keeps them within
// `max_concurrent`.
startConversationSummaryWorker();

// Scheduled tasks: fires each user's saved prompts on their cadence, as
// background-priority chat turns (see server/scheduled/runner.ts). Fails any run
// a restart cut off, on its first tick. No-op when `[scheduled_tasks] enabled = false`.
startScheduledTaskRunner();

// Sample event-loop stalls from boot, so a request that was queued behind a
// synchronous sweeper can be told apart from one that did the work itself —
// `cpu` reads the same either way, because it counts the whole process. Unref'd,
// so it adds nothing to shutdown.
startLoopLagSampler();

// Kick off MCP server connections in parallel with whatever the first
// request happens to need. The chat-completion handler awaits readiness
// before advertising tools so the model never sees a partially-populated
// MCP surface; the rest of the app is unblocked.
void bootstrapMcp();

// Warm the model-list cache in the background for the same reason. The cache is
// stale-while-revalidate, so steady state is free — but a COLD miss awaits a
// real /v1/models round trip to every configured endpoint, and the send path
// consults it before dispatching. That put the full round trip (or, for a down
// endpoint, its entire `request_timeout_seconds`) in front of the first message
// after every restart — precisely the send someone is watching right after a
// deploy. Failures are already cached per endpoint, so a warm attempt that
// fails costs nothing extra.
void listAllModels().catch(() => {});

// Clean shutdown on SIGTERM (adapter-node's graceful_shutdown emits
// 'sveltekit:shutdown' after closing the HTTP server and before the
// SHUTDOWN_TIMEOUT grace period expires). Without this listener the
// event loop never drains — the background sweepers' timers (all mounted
// through createSweeper) keep it alive — and the supervisor SIGKILLs. Each stop*() clears its
// timer or bumps its generation so the in-flight tick's completion
// callback won't re-arm. The MCP and pool closers await connections to
// drain, so in-flight tool calls / interpreter runs finish before the
// process exits.
//
// Node's EventEmitter doesn't await async callbacks, so this handler
// is effectively fire-and-forget — teardown starts immediately and the
// SHUTDOWN_TIMEOUT / stop_grace_period window provides the time budget.
// A future slow operation added here won't block shutdown; if blocking
// is ever needed, call process.exit() explicitly after the awaits.
//
// Draining the gates comes first: durable generations have no request behind
// them, so closing the server doesn't stop the queue granting its next job, and
// one running upstream call is enough to keep the loop alive. With the gates
// drained, the process exits once what already holds a slot finishes. The
// backstop bounds that (a hung upstream, a long video poll) for a SIGTERM with
// no supervisor behind it — under the shipped compose, `stop_grace_period`
// SIGKILLs first, since this hook only runs once adapter-node has closed every
// connection (up to SHUTDOWN_TIMEOUT). It's unref'd, so it never holds the
// process open itself, and a job it cuts off is the crash-restart case the job
// rows already recover from.
const SHUTDOWN_BACKSTOP_MS = 60_000;

// Drain at the signal too, not only in the hook: adapter-node emits the hook
// once every connection has closed, up to SHUTDOWN_TIMEOUT later, and in that
// window the queue went on granting jobs that a supervisor's stop timeout then
// killed — each costing the job its one interruption (generation/jobs.ts). The
// hook still drains, for a shutdown that didn't come from a signal.
//
// SIGTERM only, and not under `pnpm dev`: a signal listener replaces Node's
// default exit, so it's safe only where something else already handles the
// signal. adapter-node handles SIGTERM and SIGINT; `vite preview` only
// SIGTERM, and `vite dev` neither — a SIGINT listener here made Ctrl-C stop
// working there. Supervisors (`docker stop`, systemd) send SIGTERM anyway.
if (!import.meta.env.DEV) process.once('SIGTERM', drainEndpointGates);

process.on('sveltekit:shutdown', async () => {
	drainEndpointGates();
	setTimeout(() => {
		shutdownLog.warn(`still running ${SHUTDOWN_BACKSTOP_MS / 1000}s after shutdown began; exiting`);
		process.exit(0);
	}, SHUTDOWN_BACKSTOP_MS).unref();
	stopMediaPurger();
	stopSessionSweeper();
	stopDreamingWorker();
	stopEmbeddingBackfiller();
	stopTopicBackfiller();
	stopDimensionsBackfiller();
	stopConversationSummaryWorker();
	stopScheduledTaskRunner();
	// Only the fallback timer. Queued and running generations are deliberately
	// left alone: their rows are what the next process resumes from.
	stopGenerationJobResume();
	await stopMcp();
	await stopPool();
});

// Paths that must always revalidate against the server. Browsers
// special-case sw.js for SW updates, but reverse proxies and CDNs don't —
// without an explicit no-cache header an intermediary could serve a stale
// service worker (or manifest) and mask new versions from clients long
// after a deploy. Explicit `no-cache` lets the bytes still be cached and
// served on 304s after ETag revalidation, but forces the revalidation.
// (The manifest is a route now, not a static file, so it has no ETag and a
// revalidation re-sends its ~1 KB in full — cheap enough not to matter.)
//
// Note: SvelteKit's adapter-node already correctly tags `/_app/immutable/*`
// with `cache-control: public, max-age=31536000, immutable` (1 year),
// since those filenames are content-hashed. We only need to override for
// the small set of non-hashed root-level assets that change between
// deploys but live at stable URLs.
const ALWAYS_REVALIDATE_PATHS = new Set(['/service-worker.js', '/manifest.webmanifest']);

/**
 * State-mutating methods that need a same-origin Origin header on
 * /api/* — see the `csrf` hook.
 */
const STATE_MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** Subtree the auth rate limiter covers — see the `rateLimit` hook. */
const AUTH_RATE_LIMIT_PATH_PREFIX = '/api/auth/';

/**
 * When `serverTiming` last ran, for the `idle` Server-Timing field.
 *
 * The slow cold launches this instrumentation chases are intermittent, and the
 * variable that best predicts them is not anything the panel could see: how long
 * the process had been doing nothing before the request arrived. A host reclaims
 * an idle container's pages, and a spun-down volume stays spun down, on a clock
 * measured from the last activity — not from process start, which `proc` already
 * reports and which the readings have already ruled out.
 *
 * Two things do NOT reset it: static assets, which adapter-node serves ahead of
 * the SSR handler and which therefore never reach this hook, and the container's health
 * probe (see HEALTH_PROBE_PATH). Enumerating only the first of those is what
 * shipped this field capped at 30 seconds — if another unattended poller is ever
 * added, it belongs on that list too.
 *
 * Any real client resets it, including another user and a presence heartbeat —
 * at household scale that is the intended meaning ("was anyone using this?"),
 * not a flaw. So it is a floor on CLIENT traffic, and not a measure of process
 * idleness at all: five sweepers run on 5- and 15-minute cadences and touch
 * SQLite without resetting anything, so a large reading here does not mean the
 * process was quiet or that a volume was ever allowed to spin down.
 *
 * Starts at 0 so the process's first request reports its idle gap as the whole
 * uptime, which is what it is.
 */
let lastRequestAt = 0;

/** The path the Dockerfile's HEALTHCHECK polls; excluded from `lastRequestAt`. */
const HEALTH_PROBE_PATH = '/api/health';

/**
 * Bucket key for the rate limiter.
 *
 * `getClientAddress()` throws when the platform can't determine an address
 * (adapter-node with no `ADDRESS_HEADER` and no socket peer — reachable in
 * some test and edge runtimes). Falling back to a single shared key keeps the
 * limiter closed rather than silently off: an address we can't identify still
 * gets counted, just collectively.
 */
function clientKey(event: Parameters<Handle>[0]['event']): string {
	try {
		return event.getClientAddress();
	} catch {
		return 'unknown';
	}
}

/**
 * Per-request timings shared between the hooks below: `serverTiming` opens the
 * record and stamps it, and the hooks it wraps fill in their spans. Keyed on
 * `locals`, which is one object for the life of a request.
 */
interface RequestTimings {
	start: number;
	usageStart: NodeJS.ResourceUsage;
	idleMs: number;
	authMs: number;
	renderMs: number;
	zipMs: number;
}
const timings = new WeakMap<App.Locals, RequestTimings>();

/**
 * Trims a `Link` header to the proxy's header budget. Outermost, so it runs
 * last and prices the finished header block.
 */
const headerBudget: Handle = async ({ event, resolve }) => {
	const response = await resolve(event);
	// Dormant since SvelteKit 3, which puts the modulepreload hints in the
	// document's <head> unless `output.linkHeaderPreload` is on (it isn't — see
	// tests/e2e/proxy-header-budget.spec.ts), so no Link header reaches here.
	// Kept as the guard for that option: a Link header restates every client
	// chunk and once pushed the block past a proxy's 4 KB buffer (a 502). Last,
	// because it prices the block only once every other header is on it —
	// including the Server-Timing that `serverTiming` set, and any Set-Cookie from a
	// session renewal. See header-budget.ts for why it trims rather than drops.
	const link = response.headers.get('link');
	if (link) {
		const others = [...response.headers].filter(([name]) => name.toLowerCase() !== 'link');
		const budget =
			PROXY_HEADER_BUFFER_BYTES -
			HEADER_BUDGET_RESERVE_BYTES -
			TRANSPORT_OVERHEAD_BYTES -
			headerBlockBytes(others) -
			'link: \r\n'.length;
		const trimmed = trimToBudget(link, budget);
		if (trimmed === null) response.headers.delete('link');
		else if (trimmed !== link) response.headers.set('link', trimmed);
	}
	return response;
};

/**
 * Opens the request's timing record and, on the way out, stamps Server-Timing.
 * Wraps everything but the header budget, so the span covers compression.
 */
const serverTiming: Handle = async ({ event, resolve }) => {
	// Request entry, for the Server-Timing header set at the bottom. Taken HERE
	// and not just before resolve(): session validation below is what first
	// calls getDb(), which opens SQLite and runs migrate() lazily (see the
	// comment on adminBootstrapChecked). On the first request after a container
	// restart — the case the debug panel's server/network split exists to
	// diagnose — that work is substantial, and anything outside this span gets
	// subtracted into "Network" and read as a slow wire.
	const start = performance.now();
	// Alongside the wall clock, the process's own resource counters, so the stamp
	// at the bottom can say whether a slow request was WORKING or WAITING. One
	// getrusage(2), taken unconditionally because nothing here knows yet whether
	// this will end up being a signed-in document; the syscall is cheaper than
	// the bookkeeping a lazier capture would need.
	const usageStart = process.resourceUsage();
	// Sub-spans of the same total (`authMs` / `renderMs` / `zipMs`, declared at
	// the points they're measured) are reported alongside it. One opaque `ssr`
	// number said a cold launch spent 2.35s on the server and nothing about
	// WHERE, which left "the container had just restarted", "a load blocked on
	// an upstream" and "compressing a large document" indistinguishable from a
	// reading taken hours after the fact — the only kind this panel can get.

	// Every path-prefix gate in these hooks compares against `routedPathname`,
	// never `event.url.pathname`. The raw pathname is still percent-encoded here while
	// SvelteKit routes on a decoded copy, so matching the raw form lets
	// `/api/%61uth/…` (or `/%61pi/…`) reach the real handler while sliding past
	// the gate. See routedPathname's docstring.
	const path = routedPathname(event.url.pathname);

	// Read before the update below, so this request sees the gap that preceded
	// it rather than zero. Clamped because the two ends are wall-clock reads and
	// an NTP step backwards between them would otherwise emit a negative `dur=`.
	const idleMs =
		lastRequestAt === 0 ? process.uptime() * 1000 : Math.max(0, Date.now() - lastRequestAt);
	// The container's own HEALTHCHECK must not count as activity. `/api/health`
	// is a dynamic route, so unlike a static asset it DOES reach this hook, and
	// the Dockerfile polls it every 30s — which silently capped this metric at
	// the probe interval, in exactly the containerised deployment it was written
	// for. It kept rendering a plausible number that was never the real one.
	// Only the write is skipped: a probe response is not a document, so it never
	// reports `idleMs` in the first place.
	if (path !== HEALTH_PROBE_PATH) lastRequestAt = Date.now();

	const timing: RequestTimings = { start, usageStart, idleMs, authMs: 0, renderMs: 0, zipMs: 0 };
	timings.set(event.locals, timing);
	const response = await resolve(event);

	// Server-Timing on documents only, stamped LAST so the span covers
	// everything the server did — from request entry (see `start`) through
	// compression, which buffers the whole body and costs tens of milliseconds
	// on a long chat. Any time left outside this span does not vanish: the debug
	// panel derives network as TTFB minus this number, so it gets billed to the
	// wire and sends the reader hunting for a network problem that is actually
	// brotli, or a cold DB open. Documents only because that's the entry the
	// browser files it on; an API response's timing shows up nowhere the
	// client can correlate it. Same-origin, so no Timing-Allow-Origin needed.
	//
	// `ssr` is the total and the other three are its parts, so the panel can
	// keep showing one headline number and break it down underneath. `proc` is
	// process uptime, not a duration of this request — it rides along here
	// because Server-Timing is already plumbed through to the client and the
	// question it answers is the first one to ask of a slow SSR: was this the
	// first request a freshly-started container ever served? A 2.3s render on a
	// process that booted four seconds ago is a cold start; the same number on
	// one that's been up nine hours is a different bug entirely, and nothing in
	// the reading distinguished them.
	if (response.headers.get('content-type')?.startsWith('text/html')) {
		const dur = (v: number) => v.toFixed(1);
		const metrics = [
			`ssr;dur=${dur(performance.now() - timing.start)}`,
			`auth;dur=${dur(timing.authMs)}`,
			`render;dur=${dur(timing.renderMs)}`,
			`zip;dur=${dur(timing.zipMs)}`,
			// A slice OF `render`, not a fourth part of `ssr` — time inside
			// synchronous SQLite, summed over the call sites that opted in via
			// `timeDb`. Read it as a FLOOR: zero means no wrapped query ran, which
			// is not the same as none did. See db-timing.ts for the helper's
			// semantics and how to find what's currently covered.
			`db;dur=${dur(event.locals.dbMs ?? 0)}`,
		];
		// Signed-in only. Uptime is weak but real recon on an internet-facing
		// box — it dates the last restart, and so the last patch — and the
		// unauthenticated document surface (/login, /join/<token>) has no debug
		// panel to read it anyway. `cpu` and `fault` are gated for the same reason
		// without being the same kind of number: both are deltas across this one
		// request's span — which is why the panel files them under "This load"
		// rather than beside the uptime in Environment — but both are read off
		// process-wide counters, so they still describe the box, and the surface
		// that would read them doesn't exist unauthenticated either.
		if (event.locals.user) {
			const usage = process.resourceUsage();
			// CPU actually burned during the span above. When it lands far under
			// `ssr`, the server spent the difference NOT RUNNING — a wholly
			// different problem from the same wall time spent on honest work, and
			// one that `ssr` alone cannot distinguish. The case this exists for is
			// a container idle for hours on a NAS, whose next request pays to fault
			// back in whatever the host evicted while nothing was asking.
			//
			// `fault` (major page faults) counts exactly that, and the database is
			// squarely in scope: `db/client.ts` sets `PRAGMA mmap_size` to 256MB, so
			// the main DB file is mapped read-only and file-backed, and a query
			// touching a page the host reclaimed faults it in as a MAJOR fault.
			// That's the point rather than a caveat — clean file-backed pages need
			// no swap to be evicted, so they're the first thing an idle container
			// loses and the likeliest source of a nonzero reading here.
			//
			// Read it in one direction only. Nonzero means memory that was no
			// longer resident had to be fetched back; zero does NOT clear the box,
			// because plenty of waiting never reaches this counter — WAL frames,
			// writes and any main-DB read past the 30MB cap go through read(2),
			// which bills to blocked wall time alone, and the JS heap is anonymous
			// memory that only faults back where the host has swap.
			//
			// Both counters are process-wide, so concurrent work inflates them and
			// `cpu` can even exceed `ssr` — libuv's threadpool and the GC burn CPU
			// on other threads. Acceptable here because the reading this is built
			// for is a cold launch's first document, which is essentially alone;
			// anywhere else, read it as an upper bound.
			const cpuUs =
				usage.userCPUTime -
				timing.usageStart.userCPUTime +
				(usage.systemCPUTime - timing.usageStart.systemCPUTime);
			metrics.push(`cpu;dur=${dur(cpuUs / 1000)}`);
			// A count, not a duration — the same `dur=` abuse as `proc`, for the
			// same reason: Server-Timing is already plumbed through to the client
			// and PerformanceServerTiming exposes exactly one numeric field.
			metrics.push(`fault;dur=${usage.majorPageFault - timing.usageStart.majorPageFault}`);
			// Longest stretch the loop was unavailable while this request was open.
			// Only meaningful against `cpu`: stalled with cpu to match is synchronous
			// JavaScript, stalled with almost no cpu is a blocking syscall — which is
			// what a synchronous SQLite read off a cold page cache looks like, and
			// what `cpu` alone reports as an idle server.
			metrics.push(`lag;dur=${dur(maxLoopLagSince(timing.start))}`);
			// Current resident set, in bytes. The fault counter says memory was
			// reclaimed; it cannot say whether the process's own footprint is growing
			// over days or whether a steady footprint is simply being squeezed harder
			// by the host. Those have opposite fixes — one is a leak here, the other
			// is memory pressure there — and read against `proc` this separates them.
			// `memoryUsage.rss()` is the cheap single-value path, and unlike
			// getrusage's maxRSS it reports CURRENT usage in bytes on every platform
			// rather than a high-water mark in platform-dependent units.
			metrics.push(`rss;dur=${process.memoryUsage.rss()}`);
			// How much of the process is currently swapped out. `fault` proves
			// memory was fetched back but not from WHERE, and the two sources have
			// opposite fixes — see util/proc-swap.ts. Null off Linux, where the
			// panel drops the row rather than printing a zero it can't stand behind.
			const swapped = swapBytes();
			if (swapped !== null) metrics.push(`swap;dur=${swapped}`);
			// Database size against the mapping actually in force. Together these
			// answer the one question the panel has been inferring: whether reads are
			// being served from the mapping or through `read(2)`, which bills to
			// blocked wall time and registers no fault at all. `mmap` is the value
			// SQLite reported back after the PRAGMA, not the one we asked for — it
			// clamps at a compile-time maximum, silently.
			const dbFile = dbFileBytes();
			if (dbFile.main !== null) metrics.push(`dbsize;dur=${dbFile.main}`);
			if (dbFile.wal !== null) metrics.push(`walsize;dur=${dbFile.wal}`);
			const mmap = mmapBytes();
			if (mmap !== null) metrics.push(`mmap;dur=${mmap}`);
			metrics.push(`idle;dur=${dur(timing.idleMs)}`);
			metrics.push(`proc;dur=${dur(process.uptime() * 1000)}`);
		}
		response.headers.set('Server-Timing', metrics.join(', '));
	}

	return response;
};

/**
 * Optional on-the-fly compression of dynamic responses. Inside `serverTiming`,
 * so its cost is reported (`zip`) rather than billed to the network.
 */
const compression: Handle = async ({ event, resolve }) => {
	const response = await resolve(event);
	// On-the-fly compression for SSR + JSON, on by default (COMPRESS_DYNAMIC=0
	// turns it off; see its docstring in env.ts). SSE responses are excluded
	// inside maybeCompressResponse — the chat-stream UI depends on
	// unbuffered delivery.
	const zipStart = performance.now();
	let out = SHOULD_COMPRESS_DYNAMIC
		? await maybeCompressResponse(response, event.request)
		: response;
	// Streams are compressed separately, on by default (COMPRESS_STREAMS): gzip
	// flushed per event, so nothing is buffered. Only wraps the body here; the
	// compressing happens as frames are written, so `zip` doesn't include it.
	// Skipped for a client whose own probe found compressed streams held back
	// on its network (`#lib/stream-probe.ts`) — except on the probe itself,
	// which has to keep testing.
	const clientOptedOut =
		event.cookies.get(STREAM_GZIP_COOKIE) === '0' && event.url.pathname !== STREAM_PROBE_PATH;
	if (SHOULD_COMPRESS_STREAMS && !clientOptedOut) {
		out = maybeCompressStream(out, event.request);
	}
	const timing = timings.get(event.locals);
	if (timing) timing.zipMs = performance.now() - zipStart;
	return out;
};

/** Security headers and the revalidate override, on every response — including
 *  the gates' own 403 and 429 below. */
const securityHeaders: Handle = async ({ event, resolve }) => {
	const path = routedPathname(event.url.pathname);
	const response = await resolve(event);
	applySecurityHeaders(response, path);
	if (ALWAYS_REVALIDATE_PATHS.has(event.url.pathname)) {
		response.headers.set('cache-control', 'no-cache');
	}
	return response;
};

/** EXTERNAL_BASE_URL's origin, or null unless it's a parseable http(s) URL. */
function declaredOrigin(): string | null {
	// Unset, publicBaseUrl() falls back to the dev default — an origin no
	// operator declared, so it earns no trust here.
	if (!process.env.EXTERNAL_BASE_URL) return null;
	try {
		// Only a real http(s) origin: a scheme-less `chat.lan:3000` parses with
		// `chat.lan:` as its scheme and an origin of "null", which an
		// `Origin: null` header (a no-referrer form post) would then match.
		const url = new URL(publicBaseUrl());
		return url.protocol === 'http:' || url.protocol === 'https:' ? url.origin : null;
	} catch {
		return null;
	}
}

/**
 * CSRF gate for /api/* state-mutating requests — the ONLY CSRF check:
 * SvelteKit's own origin check is off (`csrf.trustedOrigins: ['*']` in
 * sveltekit.config.ts, which says why), and it never looked at the JSON
 * POST/PATCH/DELETE traffic our API actually uses anyway. It reaches /api/*
 * only, so tests/unit/csrf-gate-coverage.test.ts fails if a mutating route
 * or form action appears anywhere else. SameSite=Lax
 * on the session cookie blocks the cookie from being sent on cross-
 * origin POSTs already, but that's a property of the cookie, not
 * the route — a single explicit check here makes the same guarantee
 * at the route layer regardless of cookie-config drift.
 *
 * Preferred signal is `Sec-Fetch-Site`: it's browser-set, not
 * spoofable by attacker JS, and unaffected by reverse-proxy header
 * rewriting (where a missing X-Forwarded-Proto could otherwise make
 * Origin and event.url.origin disagree on scheme). Browsers send it only
 * to a secure target, so every https request from a modern browser is decided
 * by it.
 *
 * The Origin fallback therefore serves plain-http deployments (a LAN
 * address, a NAS without a certificate) as well as browsers too old to
 * emit Fetch-Metadata (pre-2020 Chromium / pre-16.4 Safari). There,
 * event.url.origin is wrong: adapter-node 6 takes its origin from the
 * build-time `paths.origin`, not a runtime ORIGIN, and otherwise guesses
 * `https://` + Host. So the fallback also accepts EXTERNAL_BASE_URL's
 * origin — the operator's declaration of this server's public origin,
 * which already decides cookie `Secure`, the OAuth redirect and the
 * passkey RP ID. Matching the Host header instead would be forgeable by
 * DNS rebinding; this can't be.
 *
 * GET / HEAD are unaffected — no state change, and Origin isn't
 * consistently sent on them. The OAuth callback flows
 * (/api/auth/github/callback and /api/auth/oauth/<provider>/callback)
 * are GET only and protected separately via their state cookie.
 */
const csrf: Handle = async ({ event, resolve }) => {
	const path = routedPathname(event.url.pathname);
	if (STATE_MUTATING_METHODS.has(event.request.method) && path.startsWith('/api/')) {
		const fetchSite = event.request.headers.get('sec-fetch-site');
		if (fetchSite) {
			// Browser-set. Acceptable values: same-origin (trust),
			// same-site / cross-site / none (refuse — sibling subdomains
			// and direct-navigation state changes aren't legitimate here).
			if (fetchSite !== 'same-origin') {
				return new Response('Forbidden: origin mismatch', { status: 403 });
			}
		} else {
			// Plain http, or a browser without Fetch-Metadata. Fall back to Origin.
			// A missing Origin is refused outright, so it can never match an
			// unparseable EXTERNAL_BASE_URL's null.
			const origin = event.request.headers.get('origin');
			if (!origin || (origin !== event.url.origin && origin !== declaredOrigin())) {
				return new Response('Forbidden: origin mismatch', { status: 403 });
			}
		}
	}

	return resolve(event);
};

/**
 * Populate event.locals.user on every request from the session cookie.
 * Routes/layouts decide whether to require it; this hook just *reads*.
 *
 * The bare /api/* surface (other than /api/auth/* and /api/health) checks
 * locals.user itself — done in each +server.ts to keep the hook simple.
 */
const session: Handle = async ({ event, resolve }) => {
	const path = routedPathname(event.url.pathname);
	const authStart = performance.now();
	const token = readSessionCookie(event.cookies);
	// First authenticated request of the process: run the admin-recovery check
	// once (a token means we're about to hit the DB anyway). Gated on token so
	// the unauthenticated readiness probe never triggers a DB open. Flag is set
	// before the call so a throw can't make it re-run every request.
	if (token && !adminBootstrapChecked) {
		adminBootstrapChecked = true;
		try {
			ensureAdminBootstrap();
		} catch (err) {
			authLog.error('ensureAdminBootstrap failed:', err);
		}
		// Before this request's own reads: a page load right after a restart
		// should already see the resumed queue in flight. Never throws.
		resumeGenerationJobs();
	}
	const ctx = token ? validateSessionToken(token) : null;
	// App lock. A locked session resolves to NO user, so every guard already
	// in the tree refuses it; `locals.appLock` is what lets them send it to
	// /unlock instead of /login. See server/auth/app-lock.ts.
	// With passkeys disabled instance-wide nothing could unlock it, so a stored
	// setting is suspended: no state published, and the client (settings,
	// notification-preview checkbox, keep-alive) sees app lock as off.
	let appLock: AppLockState | null = null;
	if (ctx && ctx.appLock.timeoutMs !== null && passkeyLoginEnabled()) {
		const decision = evaluateAppLock({
			timeoutMs: ctx.appLock.timeoutMs,
			unlockedUntil: ctx.appLock.unlockedUntil,
			installedApp: readInstalledAppCookie(event.cookies),
			passkeysEnabled: true,
			// Only the visible-only keep-alive counts as use; see evaluateAppLock.
			activity: event.request.method === 'GET' && path === APP_LOCK_KEEPALIVE_PATH,
			now: Date.now(),
		});
		if (decision.extendTo !== null) setSessionUnlockedUntil(ctx.sessionId, decision.extendTo);
		appLock = {
			locked: decision.locked,
			sliding: decision.sliding,
			userId: ctx.user.id,
			sessionId: ctx.sessionId,
			timeoutMs: ctx.appLock.timeoutMs,
		};
	}
	event.locals.appLock = appLock;
	event.locals.user = appLock?.locked ? null : (ctx?.user ?? null);
	event.locals.sessionId = ctx?.sessionId ?? null;
	// Renewal slid `expires_at` in the DB; push the same date to the browser.
	// Without this the cookie keeps its original `expires`, so the row and the
	// cookie drift apart and the sliding window only ever benefits a raw token
	// held outside a browser. Same token value, later expiry — not a rotation.
	if (ctx?.renewed) setSessionCookie(event.cookies, token!, ctx.expiresAt);
	// Everything above is the session round trip, and on the first request of a
	// process it also carries the lazy SQLite open + migrate().
	const timing = timings.get(event.locals);
	if (timing) timing.authMs = performance.now() - authStart;

	return resolve(event);
};

/**
 * Rate-limit the UNAUTHENTICATED auth surface.
 *
 * The target is CPU, not credential guessing: passkey login/verify runs a
 * full WebAuthn signature verification on the same event loop that serves
 * chat SSE, so unbounded volume degrades live conversations. Applied to the
 * whole `/api/auth/*` subtree — none of the SIGNED-OUT part of it is polled
 * (the app-lock keep-alive is, but only by a resolved session, which is
 * exempt below), so a limit generous enough to be invisible to real
 * sign-ins still blunts a flood.
 *
 * Deliberately AFTER session resolution, and skipped for a request whose
 * session resolved — keyed on `locals.sessionId`, NOT `locals.user`: an app-locked
 * session has no `locals.user` by design, but it is still a real account's
 * session, and its unlock ceremony must not queue behind an anonymous flood.
 * The bucket key is the client address, which behind a reverse proxy with no
 * `ADDRESS_HEADER` is the proxy for everyone — one shared bucket for the whole instance. Limiting signed-in requests too
 * would hand any unauthenticated client an instance-wide auth kill switch:
 * hold the shared bucket empty and every real user gets 429 on login, the
 * OAuth callbacks, logout, and — worst — the session-revocation endpoints,
 * which is precisely the lever an operator reaches for during the incident
 * that flood might be covering.
 *
 * Ordering costs nothing on the attack path: `validateSessionToken` only
 * runs when a cookie is actually present, so a cookieless flood still
 * reaches the limiter having done zero DB work. A flood that DOES carry
 * cookies pays one indexed lookup per request — far cheaper than the
 * WebAuthn verification this exists to bound.
 *
 * An authenticated user can still exhaust the bucket for the signed-out
 * surface, but they have an account the operator can disable, which is the
 * accountability an anonymous flooder lacks.
 */
const rateLimit: Handle = async ({ event, resolve }) => {
	const path = routedPathname(event.url.pathname);
	// `session` sets `sessionId` exactly when a session resolved, locked or not.
	// Falsy rather than `=== null` so the limiter stays ON if `session` ever
	// stops running first and the field is never written.
	if (!event.locals.sessionId && path.startsWith(AUTH_RATE_LIMIT_PATH_PREFIX)) {
		const decision = consumeRateLimitToken(clientKey(event));
		if (!decision.allowed) {
			return new Response('Too many requests', {
				status: 429,
				headers: { 'Retry-After': String(decision.retryAfterSeconds) },
			});
		}
	}

	return resolve(event);
};

/** Innermost: the saved theme on <html>, and the `render` span around the
 *  route itself. */
const themeAttribute: Handle = async ({ event, resolve }) => {
	// Apply the saved theme to <html> before first paint so there's no
	// flash of the default theme. The `gs-theme` cookie mirrors the DB pref
	// (written by the prefs PATCH) and is readable here even pre-auth /
	// cold, so the very first render is already themed. 'glyphstream' is the
	// default and carries no attribute (it falls through to :root); only the
	// alternates inject one.
	const themeCookie = event.cookies.get('gs-theme');
	const theme = themeCookie === 'claude' || themeCookie === 'chatgpt' ? themeCookie : null;

	const renderStart = performance.now();
	const response = await resolve(
		event,
		theme
			? {
					transformPageChunk: ({ html }) =>
						html.replace('<html lang="en"', `<html lang="en" data-theme="${theme}"`),
				}
			: undefined,
	);
	// Load functions plus the SSR render — the `(app)` layout load, and then the
	// page's own. Most of that is synchronous SQLite, so the candidates for a
	// `render` that dwarfs `auth` are the few things that aren't: a cold
	// model-list cache in the layout, the gallery's search leg when an
	// `[embeddings]` endpoint is configured (that one is a real network round
	// trip), or the event loop held by something else entirely — node:sqlite is
	// synchronous, so a background sweeper mid-batch blocks the request behind
	// it.
	const timing = timings.get(event.locals);
	if (timing) timing.renderMs = performance.now() - renderStart;
	return response;
};

/**
 * Outermost first. Each hook's work before `resolve` runs in this order, and
 * its work after `resolve` in reverse — so the gates run timing → CSRF →
 * session → rate limit, and a response is finished security headers →
 * compression → Server-Timing → Link budget. The order is the security
 * property: tests/unit/hooks-handle.test.ts holds it.
 */
export const handle: Handle = chainHandles(
	headerBudget,
	serverTiming,
	compression,
	securityHeaders,
	csrf,
	session,
	rateLimit,
	themeAttribute,
);

/**
 * Log unhandled server errors to stderr so Playwright's webServer log
 * (and production logs) show the actual stack instead of just a 500
 * status with a generic message body. Default SvelteKit behavior
 * swallows errors silently which makes CI debugging painful.
 *
 * Log only what's actually a server fault. handleError fires for every error,
 * including routine 404s (stale Open WebUI socket.io reconnects, bot scanners,
 * old service workers hitting moved paths) — client problems, whose logging is
 * noise that drowns out the 5xx events worth attention. SvelteKit 3 reports a
 * `kind` instead of a status, so:
 *   - `unknown`: an unexpected throw, i.e. a 500. Log it.
 *   - `framework`: SvelteKit's own errors. Log only a 5xx; a 404 is the noise.
 *   - `app` / `validation`: a deliberate `error(...)` or a rejected argument.
 *     Skipped — the code that raised it already decided what it meant, and
 *     SvelteKit 2 never sent these here at all, so logging them now would only
 *     add lines the logs never had.
 */
export const handleError: HandleServerError = (input) => {
	if (input.kind === 'app' || input.kind === 'validation') return undefined;
	const status = input.kind === 'framework' ? input.error.status : 500;
	if (status < 500) return undefined;

	const { event } = input;
	// A framework error arrives as a plain `{ status, message }`, not an Error,
	// so String() of it would log `[object Object]`.
	const stack =
		input.kind === 'framework'
			? input.error.message
			: input.error instanceof Error
				? (input.error.stack ?? input.error.message)
				: String(input.error);

	serverErrorLog.error(`${event.request.method} ${event.url.pathname} → ${status}:\n${stack}`);

	return undefined;
};
