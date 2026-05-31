/**
 * Lazy on-demand thumbnail generation for gallery grid tiles.
 *
 * Why: gallery thumbnails were being rendered from full-resolution
 * originals (1024px+ PNGs at 1-2 MB each). Native `loading="lazy"`
 * defers off-screen tiles, but every tile that does intersect still
 * pulls the full bytes — a ~30-tile screen meant ~30+ MB of "just to
 * see the gallery."
 *
 * Lazy strategy: on first GET for a given media's thumbnail, sharp
 * downsizes the original to <=512px on the long side, encodes as
 * JPEG q=75, writes to a sibling file on disk. Subsequent GETs
 * stream that cached file directly. New media generates a thumb on
 * first gallery view; existing media never needed a backfill
 * migration.
 *
 * Failure mode: if sharp can't decode the input (corrupt file, weird
 * codec) we return null and the endpoint falls back to streaming
 * the original — gallery shows a slow tile but no broken-image
 * icon. Per-file failures don't poison the cache.
 */

import sharp from 'sharp';
import { existsSync, mkdirSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { mediaDir } from '../env';

// Tuned for typical gallery grid cells (max 5-6 columns at sm+,
// 2-3 on mobile, so each cell is ~150-300px wide). 512px gives
// 2x density for retina without paying for resolution the user
// will never see at this surface.
const THUMB_MAX_DIM = 512;

// 75 is the conventional "good enough for thumbnails" quality:
// noticeable JPEG artifacts only on close inspection, ~5x smaller
// than quality=90. mozjpeg trims another ~10-15% via better
// Huffman tables / progressive scans, free of charge.
const THUMB_QUALITY = 75;

export interface ThumbnailRef {
	/** Absolute path on disk — for the endpoint to stream from. */
	absolutePath: string;
	byteSize: number;
	contentType: 'image/jpeg';
}

/** Convention: thumbs live as `{original}.thumb.jpg` siblings. Keeps
 *  the relationship discoverable on the filesystem (a glob can find
 *  all thumbs) and makes cleanup trivial (delete-original also tries
 *  to delete the .thumb.jpg neighbor — see disk-store.ts). */
export function thumbStoragePath(storagePath: string): string {
	return `${storagePath}.thumb.jpg`;
}

/**
 * Returns the cached thumbnail if it exists, otherwise generates one
 * lazily, writes it to disk, and returns it. Returns null if neither
 * is possible (source missing, sharp decode error). Callers should
 * fall back to streaming the original in the null case.
 */
export async function getOrCreateThumbnail(storagePath: string): Promise<ThumbnailRef | null> {
	const root = resolve(mediaDir());
	const sourceAbs = resolve(root, storagePath);
	if (!existsSync(sourceAbs)) return null;

	const thumbAbs = resolve(root, thumbStoragePath(storagePath));

	// Cache hit: just stat for size and return.
	if (existsSync(thumbAbs)) {
		const stats = await stat(thumbAbs);
		return {
			absolutePath: thumbAbs,
			byteSize: stats.size,
			contentType: 'image/jpeg',
		};
	}

	// Cache miss: generate. mkdir handles the case where the source
	// happens to be in a freshly-sharded directory whose siblings
	// don't exist yet (unlikely in practice — original would have
	// created the dir — but cheap).
	mkdirSync(dirname(thumbAbs), { recursive: true });
	try {
		await sharp(sourceAbs)
			.resize(THUMB_MAX_DIM, THUMB_MAX_DIM, {
				fit: 'inside',
				withoutEnlargement: true,
			})
			.jpeg({ quality: THUMB_QUALITY, mozjpeg: true })
			.toFile(thumbAbs);
		const stats = await stat(thumbAbs);
		return {
			absolutePath: thumbAbs,
			byteSize: stats.size,
			contentType: 'image/jpeg',
		};
	} catch (e) {
		// One bad input shouldn't kill the endpoint. Log + null so
		// the caller falls back to the original.
		console.warn(`[thumbnail] generation failed for ${storagePath}:`, e);
		return null;
	}
}
