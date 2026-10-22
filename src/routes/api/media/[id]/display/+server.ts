import { error } from '@sveltejs/kit';
import { createReadStream } from 'node:fs';
import { Readable } from 'node:stream';
import { requireUser } from '#lib/server/auth/guard.js';
import { getMediaForUser } from '#lib/server/db/queries/media.js';
import { getMediaStore } from '#lib/server/media/disk-store.js';
import { servableForRequest } from '#lib/server/media/trash.js';
import { getOrCreateDisplayVariant } from '#lib/server/media/display-variant.js';
import { DISPLAY_SIZES, isDisplaySize, type DisplaySize } from '#lib/media-variants.js';
import {
	attachmentDisposition,
	isNeverInlineType,
	normalizeContentType,
} from '#lib/server/media/content-type.js';
import type { RequestHandler } from './$types';

/**
 * An image at a display size: a WebP no larger than `?size=` on its long side
 * (default 1280, the chat thread's; the lightbox's `srcset` asks for the others
 * in `DISPLAY_SIZES`), or the original when a smaller copy isn't a win or can't
 * be made. Only the listed sizes — see `#lib/media-variants.ts` for why not any
 * width. Images only; a video bubble plays /content.
 */
export const GET: RequestHandler = async ({ locals, params, url }) => {
	requireUser(locals);
	const size = parseSize(url.searchParams.get('size'));

	const row = getMediaForUser(params.id, locals.user.id);
	if (!row || !servableForRequest(row, url)) error(404, 'Media not found');
	if (row.kind !== 'image') error(404, 'No display copy for this media kind');

	// A vector stays a vector: a raster copy of an SVG (a matplotlib chart from
	// the code interpreter, say) is sized to its intrinsic dimensions and blurs
	// on a high-density screen, where the original scales cleanly.
	const variant =
		normalizeContentType(row.contentType) === 'image/svg+xml'
			? null
			: await getOrCreateDisplayVariant(row.storagePath, size);
	if (variant) {
		const stream = Readable.toWeb(
			createReadStream(variant.absolutePath),
		) as unknown as ReadableStream;
		return new Response(stream, {
			headers: {
				'Content-Type': variant.contentType,
				'Content-Length': String(variant.byteSize),
				'Cache-Control': 'private, max-age=31536000, immutable',
			},
		});
	}

	// The original, with /content's rule for scriptable types (an SVG written by
	// the code interpreter is `kind: 'image'` and sharp may not decode it).
	const original = await getMediaStore().open(row.storagePath, row.contentType);
	if (!original) error(404, 'Media not found');
	const headers: Record<string, string> = {
		'Content-Type': normalizeContentType(original.contentType),
		'Content-Length': String(original.contentLength),
		'Cache-Control': 'private, max-age=31536000, immutable',
	};
	if (isNeverInlineType(row.contentType)) {
		headers['Content-Disposition'] = attachmentDisposition(row.originalFilename ?? row.id);
	}
	return new Response(Readable.toWeb(original.stream) as unknown as ReadableStream, { headers });
};

function parseSize(raw: string | null): DisplaySize {
	if (raw === null) return DISPLAY_SIZES[0];
	const n = Number(raw);
	if (!isDisplaySize(n)) error(400, `size must be one of ${DISPLAY_SIZES.join(', ')}`);
	return n;
}
