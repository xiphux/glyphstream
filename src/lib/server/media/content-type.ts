/**
 * Safe-serving decisions for stored media: what a stored content type really
 * is, whether it may be sent inline, and how to spell the attachment header.
 *
 * These live together in `$lib` rather than beside the route because SvelteKit
 * validates route-file exports against a fixed list — two `+server.ts` files
 * can't share a helper directly, and both media routes need the identical
 * rule. Divergence between them was the bug this module exists to prevent.
 *
 * A content type arriving from a multipart upload is whatever the client put
 * in the part header, and `File.type` preserves parameters verbatim — a part
 * declaring `image/svg+xml; charset=utf-8` yields exactly that string. Every
 * check that compared the raw value with `===` therefore missed it while
 * `startsWith('image/')` still matched, which classified a scriptable SVG as
 * an ordinary image and served it inline from our own origin.
 *
 * The fix is to compare essences, never raw values. `normalizeContentType`
 * produces the essence (parameters stripped, lowercased); the media store
 * normalizes on write so stored rows are clean going forward, and the serving
 * routes normalize on read so rows written before this change are handled too.
 */

/** The SVG essence — refused at upload and never served inline. */
export const SVG_CONTENT_TYPE = 'image/svg+xml';

/**
 * Essences that must never be served with an inline disposition. Serving any
 * of these from our origin under the user's session hands the document a
 * same-origin script context: SVG via `<script>`, HTML directly, XML via an
 * XSLT processing instruction.
 *
 * `kind: 'file'` already forces attachment regardless, so in practice this
 * guards the `kind: 'image'` rows — but enumerating the whole class keeps the
 * rule true if a future classification change lets one of the others through.
 */
const NEVER_INLINE_TYPES: ReadonlySet<string> = new Set<string>([
	SVG_CONTENT_TYPE,
	'text/html',
	'application/xhtml+xml',
	'text/xml',
	'application/xml',
]);

/**
 * Reduce a content type to its essence: parameters stripped, whitespace
 * trimmed, lowercased. `image/svg+xml; charset=utf-8` → `image/svg+xml`.
 *
 * Returns an empty string for empty input; callers that need a fallback
 * (`application/octet-stream`) apply it themselves, since the right default
 * differs between the upload boundary and the store.
 */
export function normalizeContentType(raw: string): string {
	return raw.split(';')[0].trim().toLowerCase();
}

/** True when the type must be sent as an attachment rather than inline. */
export function isNeverInlineType(raw: string): boolean {
	return NEVER_INLINE_TYPES.has(normalizeContentType(raw));
}

/**
 * Build an RFC 6266 `Content-Disposition: attachment` header value with
 * both a 7-bit ASCII `filename=` fallback (for the handful of clients
 * that still don't grok RFC 5987) and a UTF-8 `filename*=` variant so
 * non-ASCII names round-trip correctly. The two forms can disagree —
 * modern browsers prefer `filename*=`.
 */
export function attachmentDisposition(filename: string): string {
	const ascii = filename.replace(/[^\x20-\x7E]/g, '_').replace(/["\\]/g, '_');
	// encodeURIComponent leaves a few chars (' ( ) *) that aren't valid
	// in RFC 5987's attr-char production. Percent-encode them too.
	const utf8 = encodeURIComponent(filename).replace(
		/['()*]/g,
		(c) => '%' + c.charCodeAt(0).toString(16).toUpperCase(),
	);
	return `attachment; filename="${ascii}"; filename*=UTF-8''${utf8}`;
}
