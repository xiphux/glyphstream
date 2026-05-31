import type { Handle, HandleServerError } from '@sveltejs/kit';
import { readSessionCookie, validateSessionToken } from '$lib/server/auth/session';
import { startMediaPurger } from '$lib/server/media/purger';
import { bootstrapMcp } from '$lib/server/mcp/bootstrap';

// Start the media purge sweeper at module load — runs once per Node process.
// Using top-level rather than the first-request handler so the sweep clock
// starts even if no user has hit the server yet (e.g. on a fresh redeploy).
startMediaPurger();

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
 * Not set here: HSTS. TLS termination happens at the Synology reverse
 * proxy in the canonical deployment, so HSTS belongs on the proxy where
 * the operator picks the max-age + preload posture.
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
	const token = readSessionCookie(event.cookies);
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
