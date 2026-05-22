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
		'Cache-Control': 'private, max-age=31536000, immutable'
	};
	if (result.contentRange) {
		headers['Content-Range'] = `bytes ${result.contentRange.start}-${result.contentRange.end}/${result.contentRange.total}`;
	}

	const webStream = Readable.toWeb(result.stream) as unknown as ReadableStream;
	return new Response(webStream, { status, headers });
};

/**
 * Parse a single-range `Range: bytes=A-B` header. Suffix-only ranges
 * (`bytes=-N`) are supported. Multi-range or malformed input returns null
 * so the caller can serve full content.
 */
function parseRange(
	header: string | null,
	totalBytes: number
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
