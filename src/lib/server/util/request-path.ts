/**
 * The pathname a request will actually be ROUTED on.
 *
 * `event.url.pathname` inside `hooks.handle` is the raw request target, still
 * percent-encoded. SvelteKit routes on a *decoded* copy it makes separately and
 * never writes back (`respond.js`: `event.url` is the raw URL; `resolved_path`
 * is decoded via `decode_pathname` and handed to `find_route`). So a hook that
 * prefix-matches `event.url.pathname` and a router that matched the decoded
 * form can disagree — `/api/%61uth/passkey/login/verify` reaches the real
 * `/api/auth/passkey/login/verify` handler while failing
 * `startsWith('/api/auth/')`, and `/%61pi/...` likewise slips a `/api/` test.
 *
 * Any gate in `handle` keyed on a path prefix therefore has to compare against
 * this, not against `event.url.pathname` — otherwise the gate is opt-out by
 * anyone who can spell a character in hex.
 *
 * The `%25` split mirrors SvelteKit's own `decode_pathname` exactly (kit's
 * `utils/url.js`: `pathname.split('%25').map(decodeURI).join('%25')`), so a
 * double-encoded path collapses here by precisely as much as it does for
 * routing and no further. Matching the router's own transformation is the
 * point: the two cannot drift into disagreeing about the same request.
 */
export function routedPathname(pathname: string): string {
	try {
		return pathname.split('%25').map(decodeURI).join('%25');
	} catch {
		// Malformed escape (a lone `%`, `%zz`). `decodeURI` throws a URIError,
		// and SvelteKit's decode_pathname throws on the same input and answers
		// 400 before any route runs. Returning the raw value keeps this helper
		// total; the request dies upstream of anything the gates protect.
		return pathname;
	}
}
