import process from 'node:process';
import type { Handle, HandleServerError } from '@sveltejs/kit';
import {
	readSessionCookie,
	setSessionCookie,
	validateSessionToken,
} from '$lib/server/auth/session';
import { maybeCompressResponse } from '$lib/server/compression';
import { applySecurityHeaders } from '$lib/server/security-headers';
import { consumeRateLimitToken } from '$lib/server/rate-limit';
import { routedPathname } from '$lib/server/util/request-path';
import { compressDynamicResponses, validateAuthMethodsEnabled } from '$lib/server/env';
import { ensureAdminBootstrap } from '$lib/server/db/queries/users';
import { startMediaPurger, stopMediaPurger } from '$lib/server/media/purger';
import {
	startEmbeddingBackfiller,
	stopEmbeddingBackfiller,
} from '$lib/server/memory/embedding-backfill';
import { startTopicBackfiller, stopTopicBackfiller } from '$lib/server/memory/topic-backfill';
import { startDreamingWorker, stopDreamingWorker } from '$lib/server/memory/dreaming';
import {
	startConversationSummaryWorker,
	stopConversationSummaryWorker,
} from '$lib/server/memory/conversation-summary';
import { bootstrapMcp } from '$lib/server/mcp/bootstrap';
import { listAllModels } from '$lib/server/endpoints/list-models';
import { stopMcp } from '$lib/server/mcp/registry';
import { stopPool } from '$lib/server/code-interpreter/pool';

// Refuse to start if the auth-method toggles leave no way in. Better to
// crash at boot with a clear message than serve a /login page with zero
// buttons. Also catches the "passkeys on but EXTERNAL_BASE_URL not set in
// prod" misconfig, since the RP ID is derived from it.
validateAuthMethodsEnabled();

// Upgrade recovery (single-user → multi-user): a pre-multi-user DB gets the
// new `role` column defaulted to 'user' and therefore zero admins, with
// /setup already closed — so we promote the original operator. Run ONCE,
// lazily, on the first authenticated request (see `handle`) rather than at
// module load: it must not open the DB at boot, both to avoid doing DB work
// before the connection is needed and so the e2e harness (which wipes +
// recreates the DB in global-setup) can't race a boot-time connection.
let adminBootstrapChecked = false;

// Resolve the COMPRESS_DYNAMIC env var once at module load — there's no
// reason to re-read on every request, and a deploy that flips it
// restarts the process anyway.
const SHOULD_COMPRESS_DYNAMIC = compressDynamicResponses();

// Start the media purge sweeper at module load — runs once per Node process.
// Using top-level rather than the first-request handler so the sweep clock
// starts even if no user has hit the server yet (e.g. on a fresh redeploy).
startMediaPurger();

// Backfill embeddings for saved memories + gallery prompts (recall_memory and
// semantic gallery search). No-op when no `[embeddings]` block is configured.
// Same boot-time rationale as the purger.
startEmbeddingBackfiller();

// Backfill topic labels for saved memories created before the `topic` field
// (the over-budget index shows a content snippet until then). Uses the task
// model; no-op when no `task_model` is configured, and self-stops once the
// historical backlog is drained.
startTopicBackfiller();

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
// event loop never drains — the five recursive setTimeout chains above
// keep it alive — and the supervisor SIGKILLs. Each stop*() clears its
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
process.on('sveltekit:shutdown', async () => {
	stopMediaPurger();
	stopDreamingWorker();
	stopEmbeddingBackfiller();
	stopTopicBackfiller();
	stopConversationSummaryWorker();
	await stopMcp();
	await stopPool();
});

// Paths that must always revalidate against the server. Browsers
// special-case sw.js for SW updates, but reverse proxies and CDNs don't —
// without an explicit no-cache header an intermediary could serve a stale
// service worker (or manifest) and mask new versions from clients long
// after a deploy. Explicit `no-cache` lets the bytes still be cached and
// served on 304s after ETag revalidation, but forces the revalidation.
//
// Note: SvelteKit's adapter-node already correctly tags `/_app/immutable/*`
// with `cache-control: public, max-age=31536000, immutable` (1 year),
// since those filenames are content-hashed. We only need to override for
// the small set of non-hashed root-level assets that change between
// deploys but live at stable URLs.
const ALWAYS_REVALIDATE_PATHS = new Set(['/service-worker.js', '/manifest.webmanifest']);

/**
 * State-mutating methods that need a same-origin Origin header on
 * /api/* — see the check inside `handle`.
 */
const STATE_MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** Subtree the auth rate limiter covers — see the check inside `handle`. */
const AUTH_RATE_LIMIT_PATH_PREFIX = '/api/auth/';

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
 * Populate event.locals.user on every request from the session cookie.
 * Routes/layouts decide whether to require it; this hook just *reads*.
 *
 * The bare /api/* surface (other than /api/auth/* and /api/health) checks
 * locals.user itself — done in each +server.ts to keep the hook simple.
 */
export const handle: Handle = async ({ event, resolve }) => {
	// Request entry, for the Server-Timing header set at the bottom. Taken HERE
	// and not just before resolve(): session validation below is what first
	// calls getDb(), which opens SQLite and runs migrate() lazily (see the
	// comment on adminBootstrapChecked). On the first request after a container
	// restart — the case the debug panel's server/network split exists to
	// diagnose — that work is substantial, and anything outside this span gets
	// subtracted into "Network" and read as a slow wire.
	const requestStart = performance.now();

	// Every path-prefix gate below compares against THIS, never against
	// `event.url.pathname`. The raw pathname is still percent-encoded here while
	// SvelteKit routes on a decoded copy, so matching the raw form lets
	// `/api/%61uth/…` (or `/%61pi/…`) reach the real handler while sliding past
	// the gate. See routedPathname's docstring.
	const path = routedPathname(event.url.pathname);

	// CSRF gate for /api/* state-mutating requests. SvelteKit's built-in
	// csrf.checkOrigin only fires on form-encoded submissions, not the
	// JSON POST/PATCH/DELETE traffic our API actually uses. SameSite=Lax
	// on the session cookie blocks the cookie from being sent on cross-
	// origin POSTs already, but that's a property of the cookie, not
	// the route — a single explicit check here makes the same guarantee
	// at the route layer regardless of cookie-config drift.
	//
	// Preferred signal is `Sec-Fetch-Site`: it's browser-set, not
	// spoofable by attacker JS, and unaffected by reverse-proxy header
	// rewriting (where a missing X-Forwarded-Proto could otherwise make
	// Origin and event.url.origin disagree on scheme). Falls back to a
	// straight Origin compare for the handful of browsers too old to
	// emit Fetch-Metadata headers (pre-2020 Chromium / pre-16.4 Safari).
	//
	// GET / HEAD are unaffected — no state change, and Origin isn't
	// consistently sent on them. The OAuth callback flows
	// (/api/auth/github/callback and /api/auth/oauth/<provider>/callback)
	// are GET only and protected separately via their state cookie.
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
			// Legacy browser without Fetch-Metadata. Fall back to Origin.
			const origin = event.request.headers.get('origin');
			if (origin !== event.url.origin) {
				return new Response('Forbidden: origin mismatch', { status: 403 });
			}
		}
	}

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
			console.error('[auth] ensureAdminBootstrap failed:', err);
		}
	}
	const ctx = token ? validateSessionToken(token) : null;
	event.locals.user = ctx?.user ?? null;
	event.locals.sessionId = ctx?.sessionId ?? null;
	// Renewal slid `expires_at` in the DB; push the same date to the browser.
	// Without this the cookie keeps its original `expires`, so the row and the
	// cookie drift apart and the sliding window only ever benefits a raw token
	// held outside a browser. Same token value, later expiry — not a rotation.
	if (ctx?.renewed) setSessionCookie(event.cookies, token!, ctx.expiresAt);

	// Rate-limit the UNAUTHENTICATED auth surface.
	//
	// The target is CPU, not credential guessing: passkey login/verify runs a
	// full WebAuthn signature verification on the same event loop that serves
	// chat SSE, so unbounded volume degrades live conversations. Applied to the
	// whole `/api/auth/*` subtree — none of it is polled, so a limit generous
	// enough to be invisible to real sign-ins still blunts a flood.
	//
	// Deliberately AFTER session resolution, and skipped for a request that
	// resolved to a user. The bucket key is the client address, which behind a
	// reverse proxy with no `ADDRESS_HEADER` is the proxy for everyone — one
	// shared bucket for the whole instance. Limiting signed-in requests too
	// would hand any unauthenticated client an instance-wide auth kill switch:
	// hold the shared bucket empty and every real user gets 429 on login, the
	// OAuth callbacks, logout, and — worst — the session-revocation endpoints,
	// which is precisely the lever an operator reaches for during the incident
	// that flood might be covering.
	//
	// Ordering costs nothing on the attack path: `validateSessionToken` only
	// runs when a cookie is actually present, so a cookieless flood still
	// reaches the limiter having done zero DB work. A flood that DOES carry
	// cookies pays one indexed lookup per request — far cheaper than the
	// WebAuthn verification this exists to bound.
	//
	// An authenticated user can still exhaust the bucket for the signed-out
	// surface, but they have an account the operator can disable, which is the
	// accountability an anonymous flooder lacks.
	if (!event.locals.user && path.startsWith(AUTH_RATE_LIMIT_PATH_PREFIX)) {
		const decision = consumeRateLimitToken(clientKey(event));
		if (!decision.allowed) {
			return new Response('Too many requests', {
				status: 429,
				headers: { 'Retry-After': String(decision.retryAfterSeconds) },
			});
		}
	}

	// Apply the saved theme to <html> before first paint so there's no
	// flash of the default theme. The `gs-theme` cookie mirrors the DB pref
	// (written by the prefs PATCH) and is readable here even pre-auth /
	// cold, so the very first render is already themed. 'glyphstream' is the
	// default and carries no attribute (it falls through to :root); only the
	// alternates inject one.
	const themeCookie = event.cookies.get('gs-theme');
	const theme = themeCookie === 'claude' || themeCookie === 'chatgpt' ? themeCookie : null;

	const response = await resolve(
		event,
		theme
			? {
					transformPageChunk: ({ html }) =>
						html.replace('<html lang="en"', `<html lang="en" data-theme="${theme}"`),
				}
			: undefined,
	);
	// Whether this response gets a Server-Timing header, decided here because
	// compression below can hand back a different Response object.
	const isDocument = !!response.headers.get('content-type')?.startsWith('text/html');
	applySecurityHeaders(response, path);
	if (ALWAYS_REVALIDATE_PATHS.has(event.url.pathname)) {
		response.headers.set('cache-control', 'no-cache');
	}
	// Optional on-the-fly gzip for SSR + JSON, off by default. Use only
	// when no compression-capable proxy is in front (Synology). See the
	// COMPRESS_DYNAMIC docstring in env.ts. SSE responses are excluded
	// inside maybeCompressResponse — the chat-stream UI depends on
	// unbuffered delivery.
	const finalResponse = SHOULD_COMPRESS_DYNAMIC
		? await maybeCompressResponse(response, event.request)
		: response;

	// Server-Timing on documents only, stamped LAST so the span covers
	// everything the server did — from request entry (see requestStart) through
	// compression, which buffers the whole body and costs tens of milliseconds
	// on a long chat. Any time left outside this span does not vanish: the debug
	// panel derives network as TTFB minus this number, so it gets billed to the
	// wire and sends the reader hunting for a network problem that is actually
	// brotli, or a cold DB open. Documents only because that's the entry the
	// browser files it on; an API response's timing shows up nowhere the
	// client can correlate it. Same-origin, so no Timing-Allow-Origin needed.
	if (isDocument) {
		finalResponse.headers.set(
			'Server-Timing',
			`ssr;dur=${(performance.now() - requestStart).toFixed(1)}`,
		);
	}
	return finalResponse;
};

/**
 * Log unhandled server errors to stderr so Playwright's webServer log
 * (and production logs) show the actual stack instead of just a 500
 * status with a generic message body. Default SvelteKit behavior
 * swallows errors silently which makes CI debugging painful.
 *
 * Gate on status >= 500 — handleError fires for every error including
 * routine 404s (stale Open WebUI socket.io reconnects, bot scanners,
 * old service workers hitting moved paths). Those are client problems,
 * not server problems; logging them is noise that drowns out the
 * actual 5xx events worth attention.
 */
export const handleError: HandleServerError = ({ error, event, status }) => {
	if (status < 500) return undefined;
	const stack = error instanceof Error ? (error.stack ?? error.message) : String(error);
	console.error(
		`[server error] ${event.request.method} ${event.url.pathname} → ${status}:\n${stack}`,
	);
	return undefined;
};
