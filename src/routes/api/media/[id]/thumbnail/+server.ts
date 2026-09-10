import { error } from '@sveltejs/kit';
import { requireUser } from '$lib/server/auth/guard';
import { createReadStream } from 'node:fs';
import { Readable } from 'node:stream';
import { getMediaForUser } from '$lib/server/db/queries/media';
import { getMediaStore } from '$lib/server/media/disk-store';
import { getOrCreateThumbnail } from '$lib/server/media/thumbnail';
import {
	attachmentDisposition,
	isNeverInlineType,
	normalizeContentType,
} from '$lib/server/media/content-type';
import type { RequestHandler } from './$types';

/**
 * Serve a small JPEG standing in for a stored image or video.
 *
 * Three consumers: the gallery's tile grid, and the `poster` on the
 * `<video>` in both the chat surface and the lightbox. Those two also
 * use /content, but for playback — the poster is what they show until
 * the user presses play. Note the poster is grid-sized (THUMB_MAX_DIM,
 * 512px on the long side), so on a full-viewport lightbox it is being
 * upscaled until the first decoded frame replaces it.
 *
 * On cache miss the response is delayed briefly while sharp resizes
 * + writes the thumb; on subsequent calls the file is just streamed
 * from disk. The Cache-Control matches /content's so browsers happily
 * keep the thumb in memory between gallery navigations.
 *
 * Serves images and videos. Video used to be excluded on the reasoning
 * that `preload="metadata"` + `#t=0.1` already fetched one frame rather
 * than the whole file — which was cheap enough while media sat on a
 * local disk, and stopped being true on two counts once it didn't.
 * `preload="metadata"` does not oblige a browser to decode a frame at
 * all (iOS Safari frequently doesn't), and a non-faststart mp4 — which
 * is most of what ComfyUI writes — makes it spend three range requests
 * finding the index before it could even try. The visible result was
 * blank tiles. A cached 30 KB JPEG costs one request and always works.
 */
export const GET: RequestHandler = async ({ locals, params }) => {
	requireUser(locals);

	const row = getMediaForUser(params.id, locals.user.id);
	if (!row || row.hardDeletedAt !== null) error(404, 'Media not found');

	// `file` kind only — a spreadsheet has no frame to show. Images and videos
	// both do, and both take the same path from here.
	if (row.kind !== 'image' && row.kind !== 'video') {
		error(404, 'No thumbnail for this media kind');
	}

	const thumb = await getOrCreateThumbnail(row.storagePath, row.kind);
	if (thumb) {
		const stream = Readable.toWeb(
			createReadStream(thumb.absolutePath),
		) as unknown as ReadableStream;
		return new Response(stream, {
			status: 200,
			headers: {
				'Content-Type': thumb.contentType,
				'Content-Length': String(thumb.byteSize),
				'Cache-Control': 'private, max-age=31536000, immutable',
			},
		});
	}

	// A video has no fallback worth serving: this URL is consumed as a `poster`,
	// and pointing that at an mp4 renders nothing while pulling the whole file
	// over the wire to find that out. 404 instead and let the browser show its
	// own empty state — the same thing it showed before this endpoint handled
	// video at all.
	if (row.kind === 'video') {
		// A plain Response rather than `error()` so this can carry a header:
		// SvelteKit's error path emits no `Cache-Control`, and a 404 with no
		// freshness information at all has no heuristic basis, so the browser
		// re-asks every time the <video> is created. The gallery is virtualized,
		// so that is once per scroll past the tile.
		//
		// SHORT — a minute, against the ten the server's own failure memo uses,
		// and the year the success path uses. The two windows bound different
		// things and should not be equal. The server memo bounds how often a
		// decode is ATTEMPTED, which is the expensive part; with it in place a
		// repeat request costs a map lookup, so all this header still buys is a
		// round trip. Meanwhile it is the half that can be wrong: null here also
		// covers a source that was briefly unreadable (a MEDIA_DIR mount blip),
		// which the server deliberately does NOT memoize because it self-heals —
		// and a long client cache would keep the tile blank for the full window
		// after the server had recovered. A minute kills the reload storm and
		// bounds that staleness.
		return new Response('Thumbnail unavailable', {
			status: 404,
			headers: {
				'Content-Type': 'text/plain; charset=utf-8',
				'Cache-Control': 'private, max-age=60',
			},
		});
	}

	// Generation failed (corrupt file, sharp couldn't decode). Fall back
	// to streaming the original so the user sees their image rather than
	// a broken icon — slower per-tile, but the failure mode is "the
	// gallery is slow today" instead of "the gallery is broken today."
	const store = getMediaStore();
	const fallback = await store.open(row.storagePath, row.contentType);
	if (!fallback) error(404, 'Media not found');
	const headers: Record<string, string> = {
		'Content-Type': normalizeContentType(fallback.contentType),
		'Content-Length': String(fallback.contentLength),
		'Cache-Control': 'private, max-age=31536000, immutable',
	};
	// The fallback streams the ORIGINAL bytes, so it inherits /content's
	// obligation to refuse an inline disposition for scriptable types. This
	// path is the easier one to reach: sharp fails on an oversized or
	// namespace-malformed SVG, and the code-interpreter maps a written `.svg`
	// to `kind: 'image'` — so a model coaxed into writing one lands here
	// rather than at /content, which already had the rule.
	if (isNeverInlineType(row.contentType)) {
		headers['Content-Disposition'] = attachmentDisposition(row.originalFilename ?? row.id);
	}
	const stream = Readable.toWeb(fallback.stream) as unknown as ReadableStream;
	return new Response(stream, { status: 200, headers });
};
