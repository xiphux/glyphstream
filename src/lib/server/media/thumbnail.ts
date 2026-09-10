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
 * Concurrent generations, of either kind. Small on purpose, though the two
 * kinds want it for different reasons: sharp already parallelizes a single
 * resize across its thread pool, so several at once mostly contend, while
 * ffmpeg runs as separate processes that don't contend for that pool but do
 * compete for CPU and memory. The shared point is to keep a burst of misses
 * from swamping the box while other requests (and other users' streams) need
 * CPU.
 *
 * Shared rather than per-kind so the total is bounded by one number. The cost
 * is head-of-line blocking — a fast image thumbnail can queue behind video
 * decodes — which is why the video path is bounded in time (FFMPEG_TIMEOUT_MS)
 * and no longer retries a decode that already failed.
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

/**
 * Ceiling on the decoded frame's pixel count.
 *
 * The image path gets this for free: sharp's `limitInputPixels` defaults to
 * ~268 MP, which is what stops a decompression bomb. ffmpeg has no such default
 * — a stream declaring enormous dimensions gets its frame buffers allocated
 * before the `scale` filter is ever reached, and `-frames:v 1` doesn't help
 * because the allocation happens for that one frame. Matched to sharp's number
 * so both decoders refuse the same inputs rather than each having its own idea.
 */
const FFMPEG_MAX_PIXELS = '268435456';

const execFileAsync = promisify(execFile);

/** Marks a throw that came from trying to read the SOURCE, so the failure memo
 *  can ignore everything else that shares its catch. Not a perfect line — both
 *  encoders write their output too — which is why `failed` entries expire. */
class DecodeError extends Error {
	constructor(readonly cause: unknown) {
		super('thumbnail decode failed');
		this.name = 'DecodeError';
	}
}

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
	// Only ONE of the two ways this attempt can fail is worth retrying past, so
	// they are kept apart rather than collapsed into a boolean:
	//
	//   'ok'    — a frame landed; done.
	//   'empty' — ffmpeg exited 0 and wrote nothing, which is how it reports a
	//             seek past the end of a clip shorter than SEEK_SECONDS. Frame
	//             zero will work. Retry.
	//   'error' — ffmpeg threw: undecodable input, no such binary, or a timeout
	//             kill. Re-running the identical decode at a different -ss fails
	//             identically, so retrying doubles the work and doubles the
	//             worst-case hold on a generation slot (2 x FFMPEG_TIMEOUT_MS)
	//             to reach the same answer. Rethrow instead, which also puts
	//             ffmpeg's real stderr in the log on the FIRST attempt rather
	//             than the second.
	const first = await frameAt(sourceAbs, tmpAbs, SEEK_SECONDS);
	if (first === 'ok') return;
	if (typeof first === 'object') throw first.cause;

	await runFrameAt(sourceAbs, tmpAbs, '0');
	const st = await statOrNull(tmpAbs);
	if (st === null || st.size === 0) {
		throw new Error(`ffmpeg exited cleanly but wrote no frame for ${sourceAbs}`);
	}
}

type FrameOutcome = 'ok' | 'empty' | { readonly kind: 'error'; readonly cause: Error };

/** Runs one attempt and classifies it. The distinction that matters is between
 *  ffmpeg failing and ffmpeg succeeding at producing nothing — the exit status
 *  alone can't tell those apart, so the output has to be stat'd. */
async function frameAt(sourceAbs: string, tmpAbs: string, seek: string): Promise<FrameOutcome> {
	try {
		await runFrameAt(sourceAbs, tmpAbs, seek);
	} catch (cause) {
		// Normalized so the rethrow above stays a real Error — execFile always
		// rejects with one, but the type doesn't say so.
		return { kind: 'error', cause: cause instanceof Error ? cause : new Error(String(cause)) };
	}
	const st = await statOrNull(tmpAbs);
	return st !== null && st.size > 0 ? 'ok' : 'empty';
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
			// Before -i: this bounds what the DECODER will allocate, so it has to
			// be in effect while the input is being opened.
			'-max_pixels',
			FFMPEG_MAX_PIXELS,
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
 * Recent failures, so the next request doesn't pay for the same answer again.
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
 * ENTRIES EXPIRE, and that is the important part. The obvious design — remember
 * forever, since an undecodable file stays undecodable — is wrong here, because
 * "the decode failed" and "the disk was full" arrive through the same throw.
 * Both encoders WRITE their output as part of encoding (sharp's `toFile`,
 * ffmpeg's `-y`), so an ENOSPC or EROFS on DERIVED_DIR surfaces from inside the
 * decode step and cannot be told apart from a bad codec by inspection. That
 * matters because DERIVED_DIR is explicitly a small, possibly-separate volume
 * (docs/deployment.md sizes it at about a tenth of MEDIA_DIR), so filling it is
 * an ordinary event, not a disaster scenario.
 *
 * Remembering that permanently would be the worse half of a bad trade: the
 * IMAGE path degrades by streaming full-resolution originals — the ~30 MB per
 * gallery screen this module exists to prevent — and the endpoint serves those
 * with a year-long immutable Cache-Control, so clients would go on holding the
 * originals long after the volume was fixed. Expiry means a repaired volume
 * heals itself within the TTL instead of needing a restart nobody knows to
 * perform.
 *
 * What the TTL costs on a genuinely permanent failure — a container outside the
 * shipped demuxers, or no ffmpeg on PATH — is one retry per file per TTL rather
 * than one per view. Against a virtualized gallery that is still the difference
 * between a handful an hour and a spawn per scroll.
 *
 * Matched to the 404's max-age so the two halves agree: the server stops
 * spawning for the same window the client stops asking. Keyed on `thumbAbs`,
 * not `storagePath`, so entries can't collide across DERIVED_DIR changes.
 */
const failed = new Map<string, number>();
const FAILED_MAX = 4096;
export const FAILED_TTL_MS = 600_000;

/** Remember a failure until now + TTL, pruning expired entries first so the cap
 *  is only reached by genuinely concurrent failures rather than by history. */
function rememberFailure(thumbAbs: string): void {
	const now = Date.now();
	if (failed.size >= FAILED_MAX) {
		for (const [key, until] of failed) if (until <= now) failed.delete(key);
		// Still full: everything in it is live, so drop the lot rather than grow
		// without bound. Wholesale because the entries are worth so little —
		// forgetting one costs a single re-attempt.
		if (failed.size >= FAILED_MAX) failed.clear();
	}
	failed.set(thumbAbs, now + FAILED_TTL_MS);
}

/** True while a recent failure is still worth trusting. Expired entries are
 *  dropped on read, so a path that stops being asked for stops costing memory. */
function recentlyFailed(thumbAbs: string): boolean {
	const until = failed.get(thumbAbs);
	if (until === undefined) return false;
	if (until > Date.now()) return true;
	failed.delete(thumbAbs);
	return false;
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
	if (recentlyFailed(thumbAbs)) return null;

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

			try {
				if (kind === 'video') {
					await encodeVideoThumb(sourceAbs, tmpAbs);
				} else {
					await encodeImageThumb(sourceAbs, tmpAbs);
				}
			} catch (e) {
				// Tagged so the outer catch can tell "we tried to read this file"
				// from "mkdir/rename/stat went wrong". Those three are never the
				// source's fault, so they must not be remembered at all — the same
				// carve-out the missing-source check above gets, for the same
				// reason. It is only a partial separation, since both encoders
				// also WRITE here; the TTL on `failed` covers the rest.
				throw new DecodeError(e);
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
			const reason = e instanceof DecodeError ? e.cause : e;
			console.warn(`[thumbnail] generation failed for ${storagePath}:`, reason);
			// Only what came from trying to read the source is worth remembering.
			// A failed mkdir, rename or stat says something about the volume, and
			// the volume gets fixed.
			if (e instanceof DecodeError) rememberFailure(thumbAbs);
			return null;
		}
	} finally {
		releaseSlot();
	}
}
