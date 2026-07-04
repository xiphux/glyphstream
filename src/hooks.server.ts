import type { Handle, HandleServerError } from '@sveltejs/kit';
import { readSessionCookie, validateSessionToken } from '$lib/server/auth/session';
import { maybeCompressResponse } from '$lib/server/compression';
import { compressDynamicResponses, validateAuthMethodsEnabled } from '$lib/server/env';
import { ensureAdminBootstrap } from '$lib/server/db/queries/users';
import { startMediaPurger } from '$lib/server/media/purger';
import { startEmbeddingBackfiller } from '$lib/server/memory/embedding-backfill';
import { startTopicBackfiller } from '$lib/server/memory/topic-backfill';
import { startDreamingWorker } from '$lib/server/memory/dreaming';
import { bootstrapMcp } from '$lib/server/mcp/bootstrap';

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

// Kick off MCP server connections in parallel with whatever the first
// request happens to need. The chat-completion handler awaits readiness
// before advertising tools so the model never sees a partially-populated
// MCP surface; the rest of the app is unblocked.
void bootstrapMcp();

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

/**
 * Belt-and-suspenders security headers, applied to every response.
 *
 *  - `X-Content-Type-Options: nosniff` — refuse browser MIME-sniffing.
 *    Defense in depth alongside our explicit Content-Type on media
 *    responses; without it, an old browser could sniff a misclassified
 *    upload back into `text/html` and execute it under our origin.
 *
 *  - `Referrer-Policy: strict-origin-when-cross-origin` — outbound links
 *    from the chat (model citations, user-pasted URLs the user clicks)
 *    leak only the origin, not the full path. Chat URLs of the form
 *    `/chat/<uuid>` shouldn't end up in third-party referrer logs.
 *
 *  - `X-Frame-Options: DENY` — make the "we don't want to be iframed"
 *    stance explicit. The CSP `frame-ancestors 'none'` directive (set
 *    in svelte.config.js) is the modern enforcement; this header is
 *    just for older user-agents that don't honor `frame-ancestors`.
 *
 * Not set here: HSTS. TLS termination is expected to happen at a
 * reverse proxy in front of the Node process, so HSTS belongs there
 * where the operator picks the max-age + preload posture.
 */
const SECURITY_HEADERS: Record<string, string> = {
	'X-Content-Type-Options': 'nosniff',
	'Referrer-Policy': 'strict-origin-when-cross-origin',
	'X-Frame-Options': 'DENY',
};

/**
 * Populate event.locals.user on every request from the session cookie.
 * Routes/layouts decide whether to require it; this hook just *reads*.
 *
 * The bare /api/* surface (other than /api/auth/* and /api/health) checks
 * locals.user itself — done in each +server.ts to keep the hook simple.
 */
export const handle: Handle = async ({ event, resolve }) => {
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
	if (STATE_MUTATING_METHODS.has(event.request.method) && event.url.pathname.startsWith('/api/')) {
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
	for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
		response.headers.set(name, value);
	}
	if (ALWAYS_REVALIDATE_PATHS.has(event.url.pathname)) {
		response.headers.set('cache-control', 'no-cache');
	}
	// Optional on-the-fly gzip for SSR + JSON, off by default. Use only
	// when no compression-capable proxy is in front (Synology). See the
	// COMPRESS_DYNAMIC docstring in env.ts. SSE responses are excluded
	// inside maybeCompressResponse — the chat-stream UI depends on
	// unbuffered delivery.
	if (SHOULD_COMPRESS_DYNAMIC) {
		return await maybeCompressResponse(response, event.request);
	}
	return response;
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
