import { error } from '@sveltejs/kit';
import { createReadStream } from 'node:fs';
import { Readable } from 'node:stream';
import { getMediaForUser } from '$lib/server/db/queries/media';
import { getMediaStore } from '$lib/server/media/disk-store';
import { getOrCreateThumbnail } from '$lib/server/media/thumbnail';
import type { RequestHandler } from './$types';

/**
 * Serve a grid-thumbnail variant of a stored image. Used by the
 * gallery's tile grid; the chat surface and lightbox keep pointing
 * at /content for full-resolution viewing.
 *
 * On cache miss the response is delayed briefly while sharp resizes
 * + writes the thumb; on subsequent calls the file is just streamed
 * from disk. The Cache-Control matches /content's so browsers happily
 * keep the thumb in memory between gallery navigations.
 *
 * Image-only by design. Videos already render efficiently in the
 * gallery via `preload="metadata"` + `#t=0.1` (one frame fetched, not
 * the whole file), so spinning up ffmpeg + a video-thumbnail pipeline
 * isn't worth the dependency / complexity lift.
 */
export const GET: RequestHandler = async ({ locals, params }) => {
	if (!locals.user) throw error(401, 'Authentication required');

	const row = getMediaForUser(params.id, locals.user.id);
	if (!row || row.hardDeletedAt !== null) throw error(404, 'Media not found');

	if (row.kind !== 'image') {
		throw error(404, 'No thumbnail for this media kind');
	}

	const thumb = await getOrCreateThumbnail(row.storagePath);
	if (thumb) {
		const stream = Readable.toWeb(
			createReadStream(thumb.absolutePath)
		) as unknown as ReadableStream;
		return new Response(stream, {
			status: 200,
			headers: {
				'Content-Type': thumb.contentType,
				'Content-Length': String(thumb.byteSize),
				'Cache-Control': 'private, max-age=31536000, immutable'
			}
		});
	}

	// Generation failed (corrupt file, sharp couldn't decode). Fall back
	// to streaming the original so the user sees their image rather than
	// a broken icon — slower per-tile, but the failure mode is "the
	// gallery is slow today" instead of "the gallery is broken today."
	const store = getMediaStore();
	const fallback = await store.open(row.storagePath, row.contentType);
	if (!fallback) throw error(404, 'Media not found');
	const stream = Readable.toWeb(fallback.stream) as unknown as ReadableStream;
	return new Response(stream, {
		status: 200,
		headers: {
			'Content-Type': fallback.contentType,
			'Content-Length': String(fallback.contentLength),
			'Cache-Control': 'private, max-age=31536000, immutable'
		}
	});
};
