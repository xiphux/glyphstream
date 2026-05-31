import { error } from '@sveltejs/kit';
import { requireUser } from '$lib/server/auth/guard';
import { Readable } from 'node:stream';
import { getMediaForUser } from '$lib/server/db/queries/media';
import { getMediaStore } from '$lib/server/media/disk-store';
import type { RequestHandler } from './$types';

/**
 * Serve a stored media asset. Honors HTTP Range requests so iOS Safari
 * can scrub video. Auth-gated by ownership: the media row must belong to
 * locals.user.id, or we 404 (don't leak existence).
 *
 * `kind: 'file'` is served with `Content-Disposition: attachment` so
 * browsers download it instead of trying to render it inline — PDFs in
 * particular have a long history of viewer-side script-execution bugs,
 * and Office docs / zips don't render in-browser at all. Images and
 * videos still serve inline so the gallery / chat surfaces work.
 *
 * SVG also forces attachment even though it nominally has `kind: 'image'`
 * — classifyUpload refuses SVG at the user-upload entry, but a future
 * code-interpreter path (matplotlib's SVG backend) could still land one
 * with `kind: 'image'`, and SVG opened inline executes scripts in our
 * origin under the user's session.
 */
export const GET: RequestHandler = async ({ locals, params, request }) => {
	requireUser(locals);

	const row = getMediaForUser(params.id, locals.user.id);
	if (!row || row.hardDeletedAt !== null) throw error(404, 'Media not found');

	const range = parseRange(request.headers.get('range'), row.byteSize);
	const store = getMediaStore();
	const result = await store.open(row.storagePath, row.contentType, range ?? undefined);
	if (!result) throw error(404, 'Media not found');

	const status = result.contentRange ? 206 : 200;
	const headers: Record<string, string> = {
		'Content-Type': result.contentType,
		'Content-Length': String(result.contentLength),
		'Accept-Ranges': 'bytes',
		'Cache-Control': 'private, max-age=31536000, immutable',
	};
	if (result.contentRange) {
		headers['Content-Range'] =
			`bytes ${result.contentRange.start}-${result.contentRange.end}/${result.contentRange.total}`;
	}

	const forceAttachment = row.kind === 'file' || row.contentType === 'image/svg+xml';
	if (forceAttachment) {
		headers['Content-Disposition'] = attachmentDisposition(row.originalFilename ?? row.id);
	}

	const webStream = Readable.toWeb(result.stream) as unknown as ReadableStream;
	return new Response(webStream, { status, headers });
};

/**
 * Build an RFC 6266 `Content-Disposition: attachment` header value with
 * both a 7-bit ASCII `filename=` fallback (for the handful of clients
 * that still don't grok RFC 5987) and a UTF-8 `filename*=` variant so
 * non-ASCII names round-trip correctly. The two forms can disagree —
 * modern browsers prefer `filename*=`.
 */
function attachmentDisposition(filename: string): string {
	const ascii = filename.replace(/[^\x20-\x7E]/g, '_').replace(/["\\]/g, '_');
	// encodeURIComponent leaves a few chars (' ( ) *) that aren't valid
	// in RFC 5987's attr-char production. Percent-encode them too.
	const utf8 = encodeURIComponent(filename).replace(
		/['()*]/g,
		(c) => '%' + c.charCodeAt(0).toString(16).toUpperCase(),
	);
	return `attachment; filename="${ascii}"; filename*=UTF-8''${utf8}`;
}

/**
 * Parse a single-range `Range: bytes=A-B` header. Suffix-only ranges
 * (`bytes=-N`) are supported. Multi-range or malformed input returns null
 * so the caller can serve full content.
 */
function parseRange(
	header: string | null,
	totalBytes: number,
): { start: number; end: number } | null {
	if (!header) return null;
	const match = /^bytes=(\d*)-(\d*)$/i.exec(header.trim());
	if (!match) return null;
	const startStr = match[1];
	const endStr = match[2];
	if (!startStr && !endStr) return null;

	const last = totalBytes - 1;
	if (!startStr) {
		const suffix = Number.parseInt(endStr, 10);
		if (!Number.isFinite(suffix) || suffix <= 0) return null;
		return { start: Math.max(0, totalBytes - suffix), end: last };
	}
	const start = Number.parseInt(startStr, 10);
	const end = endStr ? Number.parseInt(endStr, 10) : last;
	if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start > last) {
		return null;
	}
	return { start, end: Math.min(end, last) };
}
