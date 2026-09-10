/**
 * Lazy on-demand thumbnail generation for gallery grid tiles.
 *
 * Why: gallery thumbnails were being rendered from full-resolution
 * originals (1024px+ PNGs at 1-2 MB each). Native `loading="lazy"`
 * defers off-screen tiles, but every tile that does intersect still
 * pulls the full bytes — a ~30-tile screen meant ~30+ MB of "just to
 * see the gallery."
 *
 * Lazy strategy: on first GET for a given media's thumbnail, the
 * original is downsized to <=512px on the long side and encoded as
 * a JPEG. Subsequent GETs stream that cached file directly. New
 * media generates a thumb on first gallery view; existing media
 * never needed a backfill migration.
 *
 * VIDEO goes through the same path, with ffmpeg decoding one frame
 * where sharp would decode an image — same cache, same dedup, same
 * concurrency cap, same file naming, and deliberately the same
 * output size. It was image-only until the media directory moved to
 * network storage, at which point the old arrangement (a bare
 * `<video preload="metadata">` per tile, letting the browser fetch
 * its own poster frame) stopped being cheap: a non-faststart mp4
 * costs three range requests before the first frame can be decoded,
 * each one a round trip, and browsers are within their rights to
 * give up and render nothing. Which many did.
 *
 * Failure mode: if the input can't be decoded (corrupt file,
 * unsupported codec) we return null. For an image the endpoint
 * falls back to streaming the original — a slow tile, not a broken
 * one. For a VIDEO there is no such fallback, since a `poster`
 * pointing at an mp4 is meaningless; the endpoint 404s and the
 * browser shows its own empty state. Per-file failures don't poison
 * the cache.
 *
 * DISK-STORE-ONLY: This module reads originals via raw `node:fs`
 * paths under `mediaDir()` and writes thumbs under `derivedDir()`
 * (the same directory unless DERIVED_DIR says otherwise). It does
 * NOT go through the
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
 *
 * ffmpeg is a RUNTIME dependency of the video path only, and a
 * missing binary is just another decode failure — the image path
 * and the rest of the app are unaffected. The Dockerfile builds a
 * decode-only one (~5 MB); see the `ffmpeg` stage for why it isn't
 * the distro package.
 */

import process from 'node:process';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import sharp from 'sharp';
import { mkdirSync } from 'node:fs';
import { rename, stat, unlink } from 'node:fs/promises';
import type { Stats } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { derivedDir, mediaDir } from '../env';

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

/** Convention: a thumb takes the original's RELATIVE path plus `.thumb.jpg`,
 *  under `derivedDir()`. That is the original's own directory unless
 *  DERIVED_DIR says otherwise, so the two are siblings in the common case and
 *  merely same-named on different volumes otherwise. Either way the derived
 *  path is a pure function of the original's, which is what keeps cleanup
 *  trivial (delete-original also unlinks the .thumb.jpg — see disk-store.ts)
 *  and a glob able to find every thumb under one root. */
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

/** What the ORIGINAL is, which decides how a frame is got out of it. `file`
 *  never reaches here — the endpoint refuses it before asking. */
export type ThumbnailSourceKind = 'image' | 'video';

/**
 * The long-side cap, in ffmpeg's filter syntax.
 *
 * `force_original_aspect_ratio=decrease` fits the frame inside the box, and
 * capping the box at the source's own dimensions is what stops it ENLARGING a
 * small video. Together they reproduce sharp's `fit: 'inside'` plus
 * `withoutEnlargement: true`, so a video thumbnail and an image thumbnail obey
 * the same rule rather than two that merely look similar.
 */
const VIDEO_SCALE_FILTER = `scale=w='min(${THUMB_MAX_DIM},iw)':h='min(${THUMB_MAX_DIM},ih)':force_original_aspect_ratio=decrease`;

/**
 * ffmpeg's mjpeg scale runs 2 (best) to 31 — inverted from sharp's 1-100 and
 * not a conversion of it, so this was chosen by measuring rather than mapping.
 * Against generated video it lands around 30 KB, which is where THUMB_QUALITY
 * puts the image thumbnails (33 KB median in a real library). Matching the
 * BYTES is the point: both kinds share a grid, a cache lifetime, and whatever
 * disk DERIVED_DIR is pointed at.
 */
const VIDEO_JPEG_QSCALE = '8';

/**
 * How far into the clip to grab the frame.
 *
 * Not frame zero: generated video very often opens on black or a fade-in, which
 * makes a tile that says nothing about the video. Placed BEFORE `-i` so it is an
 * input seek — the demuxer jumps to the nearest keyframe instead of decoding
 * everything up to that point and discarding it.
 */
const SEEK_SECONDS = '0.1';

/**
 * Ceiling on a single decode.
 *
 * A malformed or adversarial file that makes ffmpeg spin would otherwise hold
 * one of the three generation slots for the life of the process, and three such
 * files would stop the gallery generating any thumbnail at all — for images too,
 * since both kinds share the semaphore.
 */
const FFMPEG_TIMEOUT_MS = 20_000;

const execFileAsync = promisify(execFile);

async function encodeImageThumb(sourceAbs: string, tmpAbs: string): Promise<void> {
	await sharp(sourceAbs)
		.resize(THUMB_MAX_DIM, THUMB_MAX_DIM, {
			fit: 'inside',
			withoutEnlargement: true,
		})
		.jpeg({ quality: THUMB_QUALITY, mozjpeg: true })
		.toFile(tmpAbs);
}

/**
 * One decoded frame, written as a JPEG.
 *
 * The retry exists because a clip shorter than SEEK_SECONDS has nothing at that
 * timestamp, and ffmpeg reports that by exiting 0 having written NOTHING rather
 * than by failing — so an empty output has to be checked for, not waited on.
 */
async function encodeVideoThumb(sourceAbs: string, tmpAbs: string): Promise<void> {
	if (await tryFrameAt(sourceAbs, tmpAbs, SEEK_SECONDS)) return;

	// Deliberately UNguarded, unlike the attempt above. A seek past the end is an
	// ordinary outcome worth retrying past; frame zero failing means the file is
	// genuinely undecodable, and then ffmpeg's own stderr is the useful thing to
	// surface — `generateThumbnail`'s catch logs it.
	await runFrameAt(sourceAbs, tmpAbs, '0');
	const st = await statOrNull(tmpAbs);
	if (st === null || st.size === 0) {
		throw new Error(`ffmpeg exited cleanly but wrote no frame for ${sourceAbs}`);
	}
}

/** True when a non-empty JPEG landed. Swallows every failure — a caller uses
 *  this to decide whether a fallback is needed, not to learn why. */
async function tryFrameAt(sourceAbs: string, tmpAbs: string, seek: string): Promise<boolean> {
	try {
		await runFrameAt(sourceAbs, tmpAbs, seek);
	} catch {
		return false;
	}
	const st = await statOrNull(tmpAbs);
	return st !== null && st.size > 0;
}

async function runFrameAt(sourceAbs: string, tmpAbs: string, seek: string): Promise<void> {
	await execFileAsync(
		'ffmpeg',
		[
			'-hide_banner',
			'-loglevel',
			'error',
			// Never let ffmpeg reach for the terminal. It has no stdin here, and a
			// build that decided to prompt would block rather than fail.
			'-nostdin',
			'-ss',
			seek,
			'-i',
			sourceAbs,
			'-frames:v',
			'1',
			'-vf',
			VIDEO_SCALE_FILTER,
			'-q:v',
			VIDEO_JPEG_QSCALE,
			// Pinned rather than inferred from the extension: tmpAbs ends in `.tmp`,
			// which ffmpeg cannot guess a muxer from.
			'-f',
			'image2',
			'-y',
			tmpAbs,
		],
		{ timeout: FFMPEG_TIMEOUT_MS, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024 },
	);
}

/**
 * Sources that failed to decode, so the next request doesn't pay for the same
 * answer again.
 *
 * Success caches itself — the thumb on disk IS the memo. Failure had nothing,
 * so every view re-ran the whole pipeline. That was tolerable while the only
 * decoder was sharp, which fails in-process in milliseconds and whose caller
 * still gets the original streamed to it. It is not tolerable for video: the
 * failure spawns a process, takes one of MAX_CONCURRENT_GENERATIONS slots, and
 * ends in a 404 that leaves the tile blank — so the user has every reason to
 * reload, and the gallery is virtualized, so merely scrolling past a tile and
 * back re-requests it.
 *
 * Two failure classes are permanent rather than transient, which is what makes
 * this worth having: a container outside the shipped demuxers (classifyUpload
 * accepts ANY `video/*`, this build reads mov and matroska), and no ffmpeg on
 * PATH at all — which docs/deployment.md documents as a supported way to run.
 * In that second case EVERY video in the library is permanently undecodable.
 *
 * In-memory and bounded, mirroring `declined` in vision-variant.ts: a restart
 * retries everything, which is the behaviour you want when the fix was
 * installing ffmpeg or rebuilding with another demuxer. Keyed on `thumbAbs`
 * rather than `storagePath` so it can't collide across DERIVED_DIR changes.
 */
const failed = new Set<string>();
const FAILED_MAX = 4096;

/** Remember a failure, clearing wholesale at the cap. Wholesale rather than LRU
 *  because the entries are worthless — the cost of forgetting one is a single
 *  re-attempt, so tracking recency would cost more than it saves. */
function rememberFailure(thumbAbs: string): void {
	if (failed.size >= FAILED_MAX) failed.clear();
	failed.add(thumbAbs);
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
export async function getOrCreateThumbnail(
	storagePath: string,
	kind: ThumbnailSourceKind = 'image',
): Promise<ThumbnailRef | null> {
	// Two roots, because the two files want different storage. The thumbnail is
	// small, hot, and regenerable; the original is large, cold, and irreplaceable.
	// They coincide unless DERIVED_DIR is set — see `derivedDir` in env.ts.
	const thumbAbs = resolve(derivedDir(), thumbStoragePath(storagePath));

	// Cache hit — the overwhelmingly common case once a library has been
	// viewed once, so it's checked before any locking.
	const cached = await statOrNull(thumbAbs);
	if (cached) {
		return { absolutePath: thumbAbs, byteSize: cached.size, contentType: 'image/jpeg' };
	}

	// Checked AFTER the disk probe, not before: a thumb that appeared since the
	// failure (a backfill, a manual copy, a rebuilt DERIVED_DIR) should win over
	// a stale memo, and the probe is one stat either way.
	if (failed.has(thumbAbs)) return null;

	const existing = inFlight.get(thumbAbs);
	if (existing) return existing;

	const source = resolve(mediaDir(), storagePath);
	const job = generateThumbnail(source, thumbAbs, storagePath, kind).finally(() => {
		inFlight.delete(thumbAbs);
	});
	inFlight.set(thumbAbs, job);
	return job;
}

async function generateThumbnail(
	sourceAbs: string,
	thumbAbs: string,
	storagePath: string,
	kind: ThumbnailSourceKind,
): Promise<ThumbnailRef | null> {
	// NOT remembered: a missing source is the one failure here that routinely
	// un-fails itself. The media row can be ahead of its bytes mid-write, and
	// under a network-mounted MEDIA_DIR a stat can fail for a mount that comes
	// back. Cheap to re-check, too — one stat, no slot taken.
	if (!(await statOrNull(sourceAbs))) return null;

	await acquireSlot();
	try {
		// Re-check under the slot: a queued request may have been waiting behind
		// the very generation that produced this file.
		const raced = await statOrNull(thumbAbs);
		if (raced) {
			return { absolutePath: thumbAbs, byteSize: raced.size, contentType: 'image/jpeg' };
		}

		// Write to a unique temp path and rename into place, so a reader can never
		// observe a half-written JPEG. rename(2) is atomic within a filesystem, and
		// the temp file sits beside the thumb so it always is. Mirrors
		// DiskMediaStore.put.
		const tmpAbs = `${thumbAbs}.${process.pid}.${randomUUID()}.tmp`;
		try {
			// mkdir handles the case where the thumb's shard doesn't exist yet —
			// routinely, now that it may live under a DERIVED_DIR nothing else has
			// written to. Inside the try because that directory may also be on a
			// volume that is absent or read-only while MEDIA_DIR is healthy, and a
			// throw here would reject getOrCreateThumbnail and 500 the tile. The
			// catch below returns null instead, which is the endpoint's documented
			// signal to degrade.
			mkdirSync(dirname(thumbAbs), { recursive: true });

			if (kind === 'video') {
				await encodeVideoThumb(sourceAbs, tmpAbs);
			} else {
				await encodeImageThumb(sourceAbs, tmpAbs);
			}
			await rename(tmpAbs, thumbAbs);
			const stats = await stat(thumbAbs);
			return { absolutePath: thumbAbs, byteSize: stats.size, contentType: 'image/jpeg' };
		} catch (e) {
			await unlink(tmpAbs).catch(() => {});
			// One bad input shouldn't kill the endpoint. Log + null: for an IMAGE
			// the caller then falls back to streaming the original, but for a VIDEO
			// there is no such fallback and the endpoint 404s — a `poster` pointing
			// at an mp4 renders nothing. See the endpoint's own comment.
			console.warn(`[thumbnail] generation failed for ${storagePath}:`, e);
			// Decode failures are overwhelmingly a property of the file (or of a
			// decoder that isn't installed), not of the moment, so don't pay for
			// this answer again on every gallery view.
			rememberFailure(thumbAbs);
			return null;
		}
	} finally {
		releaseSlot();
	}
}
