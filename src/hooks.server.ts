import type { Handle, HandleServerError } from '@sveltejs/kit';
import { readSessionCookie, validateSessionToken } from '$lib/server/auth/session';
import { startMediaPurger } from '$lib/server/media/purger';

// Start the media purge sweeper at module load — runs once per Node process.
// Using top-level rather than the first-request handler so the sweep clock
// starts even if no user has hit the server yet (e.g. on a fresh redeploy).
startMediaPurger();

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
 * Populate event.locals.user on every request from the session cookie.
 * Routes/layouts decide whether to require it; this hook just *reads*.
 *
 * The bare /api/* surface (other than /api/auth/* and /api/health) checks
 * locals.user itself — done in each +server.ts to keep the hook simple.
 */
export const handle: Handle = async ({ event, resolve }) => {
	const token = readSessionCookie(event.cookies);
	const ctx = token ? validateSessionToken(token) : null;
	event.locals.user = ctx?.user ?? null;
	const response = await resolve(event);
	if (ALWAYS_REVALIDATE_PATHS.has(event.url.pathname)) {
		response.headers.set('cache-control', 'no-cache');
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
	const stack = error instanceof Error ? error.stack ?? error.message : String(error);
	console.error(
		`[server error] ${event.request.method} ${event.url.pathname} → ${status}:\n${stack}`
	);
	return undefined;
};
