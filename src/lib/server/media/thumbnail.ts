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
 *
 * DISK-STORE-ONLY: This module reads and writes via raw `node:fs`
 * paths resolved from `mediaDir()`. It does NOT go through the
 * MediaStore interface and is therefore tied to the disk-backed
 * implementation. The gallery endpoint
 * (routes/api/media/[id]/thumbnail/+server.ts) degrades gracefully
 * under an S3 store — `getOrCreateThumbnail` returns null for
 * missing source files, and the endpoint falls back to
 * `store.open()` which streams the full-resolution original. This
 * means the gallery loses the thumbnail optimization under S3 but
 * does not break. Extending the MediaStore interface with
 * derived-asset methods (openDerived / putDerived) is deferred to
 * a future v2 change.
 */

import sharp from 'sharp';
import { mkdirSync } from 'node:fs';
import { rename, stat, unlink } from 'node:fs/promises';
import type { Stats } from 'node:fs';
import { randomUUID } from 'node:crypto';
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
 * In-flight generations, keyed by thumbnail path.
 *
 * A cold gallery viewport requests 30-60 tiles at once, every one a cache miss,
 * and each miss used to start its own independent `sharp` pipeline — dozens of
 * concurrent libvips decodes of multi-MB PNGs, competing for sharp's own thread
 * pool, precisely at first paint of a new library. Two requests for the SAME id
 * also both generated, and both wrote to the same path with no tmp+rename (which
 * `DiskMediaStore.put` does have), so they raced on the output file.
 *
 * Deduping collapses the duplicate work and makes the write single-writer per
 * path; the semaphore below bounds the rest.
 */
const inFlight = new Map<string, Promise<ThumbnailRef | null>>();

/**
 * Concurrent sharp pipelines. Small on purpose: sharp already parallelizes a
 * single resize across its thread pool, so several at once mostly contend. The
 * point is to keep a burst of misses from swamping the box while other requests
 * (and other users' streams) need CPU.
 */
const MAX_CONCURRENT_GENERATIONS = 3;
let active = 0;
const waiting: Array<() => void> = [];

async function acquireSlot(): Promise<void> {
	if (active < MAX_CONCURRENT_GENERATIONS) {
		active++;
		return;
	}
	// The slot is handed over already-held by `releaseSlot`, so there's no
	// increment here. Freeing it first and letting the woken waiter re-take it
	// would leave a gap: the waiter resumes a microtask later, so a caller
	// arriving in between passes the fast-path check, and both then increment —
	// putting `active` over the cap during exactly the burst this bounds.
	await new Promise<void>((release) => waiting.push(release));
}

function releaseSlot(): void {
	const next = waiting.shift();
	// Transfer rather than free-then-reacquire: `active` stays counted for the
	// waiter that's about to run.
	if (next) {
		next();
		return;
	}
	active--;
}

/** Stat a file, or null if it isn't there — one syscall instead of
 *  `existsSync` followed by `stat` (which asks the filesystem twice, on a
 *  path taken for every gallery tile). */
async function statOrNull(path: string): Promise<Stats | null> {
	try {
		return await stat(path);
	} catch {
		return null;
	}
}

/**
 * Returns the cached thumbnail if it exists, otherwise generates one
 * lazily, writes it to disk, and returns it. Returns null if neither
 * is possible (source missing, sharp decode error). Callers should
 * fall back to streaming the original in the null case.
 *
 * Concurrent callers for the same path share one generation, and generations
 * are globally capped — see `inFlight` and `MAX_CONCURRENT_GENERATIONS`.
 */
export async function getOrCreateThumbnail(storagePath: string): Promise<ThumbnailRef | null> {
	const root = resolve(mediaDir());
	const thumbAbs = resolve(root, thumbStoragePath(storagePath));

	// Cache hit — the overwhelmingly common case once a library has been
	// viewed once, so it's checked before any locking.
	const cached = await statOrNull(thumbAbs);
	if (cached) {
		return { absolutePath: thumbAbs, byteSize: cached.size, contentType: 'image/jpeg' };
	}

	const existing = inFlight.get(thumbAbs);
	if (existing) return existing;

	const job = generateThumbnail(resolve(root, storagePath), thumbAbs, storagePath).finally(() => {
		inFlight.delete(thumbAbs);
	});
	inFlight.set(thumbAbs, job);
	return job;
}

async function generateThumbnail(
	sourceAbs: string,
	thumbAbs: string,
	storagePath: string,
): Promise<ThumbnailRef | null> {
	if (!(await statOrNull(sourceAbs))) return null;

	await acquireSlot();
	try {
		// Re-check under the slot: a queued request may have been waiting behind
		// the very generation that produced this file.
		const raced = await statOrNull(thumbAbs);
		if (raced) {
			return { absolutePath: thumbAbs, byteSize: raced.size, contentType: 'image/jpeg' };
		}

		// mkdir handles the case where the source happens to be in a freshly-
		// sharded directory whose siblings don't exist yet (unlikely in practice —
		// the original would have created the dir — but cheap).
		mkdirSync(dirname(thumbAbs), { recursive: true });
		// Write to a unique temp path and rename into place, so a reader can never
		// observe a half-written JPEG. rename(2) is atomic within a filesystem, and
		// the temp file is a sibling so it always is. Mirrors DiskMediaStore.put.
		const tmpAbs = `${thumbAbs}.${process.pid}.${randomUUID()}.tmp`;
		try {
			await sharp(sourceAbs)
				.resize(THUMB_MAX_DIM, THUMB_MAX_DIM, {
					fit: 'inside',
					withoutEnlargement: true,
				})
				.jpeg({ quality: THUMB_QUALITY, mozjpeg: true })
				.toFile(tmpAbs);
			await rename(tmpAbs, thumbAbs);
			const stats = await stat(thumbAbs);
			return { absolutePath: thumbAbs, byteSize: stats.size, contentType: 'image/jpeg' };
		} catch (e) {
			await unlink(tmpAbs).catch(() => {});
			// One bad input shouldn't kill the endpoint. Log + null so
			// the caller falls back to the original.
			console.warn(`[thumbnail] generation failed for ${storagePath}:`, e);
			return null;
		}
	} finally {
		releaseSlot();
	}
}
