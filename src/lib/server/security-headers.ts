/**
 * Response security headers, applied to every response by `hooks.server.ts`.
 *
 * Pulled out of the hook so the policy can be unit-tested directly: importing
 * `hooks.server.ts` runs its module-load side effects (media purger, embedding
 * and topic backfillers, dreaming and summary workers, MCP bootstrap), none of
 * which a header test wants.
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
 * The CSP configured in svelte.config.js is injected by SvelteKit at *page
 * render*, so a hand-built `+server.ts` Response gets none — which is why a
 * media asset served with the wrong Content-Type had nothing behind it. This
 * gives the media routes a document-level backstop: navigating directly to a
 * stored asset yields an inert document even if a future content-type miss
 * lets a scriptable type through.
 *
 * `sandbox` (no `allow-*` tokens) drops the response into an opaque origin
 * with scripting disabled; `default-src 'none'` blocks any subresource it
 * might try to pull. Neither affects the normal path — a CSP binds only when
 * its response *is* the document, so `<img>` / `<video>` embedding, Range
 * scrubbing, and gallery tiles are untouched.
 */
export const MEDIA_CSP = "default-src 'none'; sandbox";

/** Path prefix whose responses receive {@link MEDIA_CSP}. */
const MEDIA_CSP_PATH_PREFIX = '/api/media/';

/**
 * Apply the standard headers to `response`, plus the media CSP when `pathname`
 * is a media route.
 *
 * The CSP is scoped by path rather than applied globally on purpose: setting a
 * `Content-Security-Policy` header on every response would clobber the
 * per-page CSP SvelteKit emits for SSR routes, which is the stronger policy
 * where it applies.
 *
 * Mutates and returns the same `response` — the hook already holds the object
 * returned by `resolve()`.
 */
export function applySecurityHeaders(response: Response, pathname: string): Response {
	for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
		response.headers.set(name, value);
	}
	if (pathname.startsWith(MEDIA_CSP_PATH_PREFIX)) {
		response.headers.set('Content-Security-Policy', MEDIA_CSP);
	}
	return response;
}
