/**
 * Moving an mp4's index to the front of the file, so playback can start before
 * the whole thing has been fetched.
 *
 * An mp4 is a sequence of boxes. `mdat` holds the samples; `moov` holds the
 * index that says where each sample is. Nothing can be played until `moov` has
 * been read — so when a writer puts `moov` last (which ComfyUI's SaveVideo
 * does, as do most encoders that don't opt out), a player must locate the end
 * of the file before the first frame. Over HTTP that is an extra range request
 * to the tail, then another for the samples. On a fast LAN it is invisible; on
 * a slow link it reads as "the video downloads completely before it starts",
 * which is exactly what it is doing.
 *
 * `-movflags +faststart` rewrites the file with `moov` ahead of `mdat`. It is a
 * remux, not a re-encode: `-c copy` means the bitstream is demuxed and written
 * back untouched, so there is no generation loss and no decode. The byte count
 * changes slightly because sample offsets inside `moov` have to be rewritten
 * for its new position.
 *
 * It is not one pass, though it reads like it should be: ffmpeg writes the file
 * normally and THEN shifts `mdat` in a second in-place pass to make room for
 * the relocated index, so the traffic is roughly four times the file size. That
 * is invisible on a local disk (measured ~20ms fixed plus ~0.5ms/MB) and is the
 * dominant cost once MEDIA_DIR is a network mount, which is what the size-
 * derived budget below is built around.
 *
 * Why here and not in the bridge that fetches from ComfyUI: the bridge
 * normalizes API differences and passes artifacts through verbatim — it has
 * never rewritten one, and it never plays anything either. Faststart is purely
 * a viewing concern, and this is where viewing happens. It also covers every
 * provider rather than one adapter, and the permanent copy lives here.
 */

import { open, rename, stat, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import process from 'node:process';
import { Buffer } from 'node:buffer';
import { createLogger } from '../log.ts';
import { FfmpegDeadline, runFfmpeg } from './ffmpeg.ts';

const log = createLogger('faststart');

/**
 * The remux budget is DERIVED FROM FILE SIZE, not a single number.
 *
 * A flat ceiling has to be the worst case for the largest file, which makes it
 * far too generous for every ordinary one — and this budget is spent holding an
 * endpoint slot. The sibling in `thumbnail.ts` bounds a whole file at 20s while
 * pinning one of three shared slots; a flat 120s here would be six times that
 * against a slot that on a `max_concurrent = 1` endpoint IS the endpoint, which
 * is backwards given this module's own argument about the stakes.
 *
 * Measured against the shipped build: ~20ms fixed plus ~0.5ms/MB on a local
 * disk. What actually bounds this is storage throughput, since the traffic is
 * ~4x the file size (see the header). 300ms/MB assumes ~13 MB/s of file
 * throughput, which is pessimistic for a contended NAS and absurdly so for a
 * local disk. That is what a deadline should be: a ceiling nothing healthy
 * approaches.
 */
const REMUX_BASE_MS = 15_000;
const REMUX_MS_PER_MB = 300;

/**
 * Above this, don't start at all.
 *
 * The point is to never SPEND the budget in order to fail. A file too big to
 * plausibly finish would otherwise hold the slot for the whole ceiling and then
 * be discarded — the worst of both. Declining up front costs nothing, keeps the
 * original (which is a perfectly good video, just slower to start), and says so
 * in the log. At 300ms/MB this admits files up to ~250 MB, well above anything
 * ComfyUI produces in practice.
 */
const REMUX_MAX_MS = 90_000;

const BYTES_PER_MB = 1_048_576;

/** Milliseconds to allow for remuxing `byteSize`, or null to decline. */
function remuxBudgetMs(byteSize: number): number | null {
	const projected = REMUX_BASE_MS + (byteSize / BYTES_PER_MB) * REMUX_MS_PER_MB;
	return projected > REMUX_MAX_MS ? null : Math.ceil(projected);
}

/**
 * ffmpeg arguments for the remux of `path` into `tmp`: every stream copied as
 * it is, with the index moved to the front.
 */
function remuxArgs(path: string, tmp: string): string[] {
	return [
		'-hide_banner',
		'-loglevel',
		'error',
		'-nostdin',
		'-protocol_whitelist',
		'file',
		'-i',
		path,
		// Take EVERY stream, then drop the ones mp4 can't hold.
		//
		// Without `-map`, ffmpeg applies default stream selection: one "best"
		// video and one "best" audio, and nothing else. That is silent — exit 0,
		// a genuinely faststart output that passes the check below — and then the
		// rename destroys the only copy of the original. Measured against this
		// build: a two-audio mp4 came back 3 streams -> 2 and lost 36% of its
		// bytes; a file with two subtitle tracks lost BOTH of them plus an audio
		// track.
		//
		// `-map 0` alone is not the fix. A camera original carrying a timecode
		// track exposes it as `data / codec none`, which the mp4 muxer refuses —
		// exit 234, "Could not find tag for codec none". Stock ffmpeg 6.1.1 fails
		// identically, so it is the container, not this build. That turns a lossy
		// remux into no remux at all for exactly the files most likely to need
		// one. Excluding data streams keeps the rest, and costs less than it
		// looks: ffmpeg's mov/mp4 muxer rebuilds a tmcd track from the timecode
		// metadata tag, which `-c copy` carries over — so a camera original
		// goes in with three streams and comes out with three. Verified
		// against this build under `-f mp4` (video/audio/tmcd in, same out),
		// not inferred from the mov-mode default.
		'-map',
		'0',
		'-map',
		'-0:d',
		// The whole point: copy the streams, move the index.
		'-c',
		'copy',
		'-movflags',
		'+faststart',
		// Pinned rather than inferred: the temp name ends in `.tmp`.
		'-f',
		'mp4',
		'-y',
		tmp,
	];
}

/** Box headers are 8 bytes: a 32-bit size then a 4-char type. A size of 1 means
 *  the real size is a 64-bit value in the next 8 bytes (files over 4 GB). */
const HEADER_BYTES = 8;

/**
 * Is this file's index already at the front?
 *
 * Walks only the TOP-LEVEL box headers — 8 bytes read per box, seeking past the
 * body — so it costs a handful of small reads regardless of file size. That
 * matters: the alternative of remuxing unconditionally would rewrite every
 * already-correct file, and some providers already emit faststart.
 *
 * Returns null when the question doesn't apply or can't be answered: a
 * non-mp4 container, a truncated file, an unreadable one. Callers should leave
 * those alone rather than guess.
 */
export async function isFaststart(path: string): Promise<boolean | null> {
	let handle;
	try {
		handle = await open(path, 'r');
	} catch {
		return null;
	}
	try {
		const { size } = await handle.stat();
		const header = Buffer.alloc(HEADER_BYTES + 8);
		let offset = 0;
		let sawFtyp = false;

		while (offset + HEADER_BYTES <= size) {
			const { bytesRead } = await handle.read(header, 0, header.length, offset);
			if (bytesRead < HEADER_BYTES) return null;

			const type = header.toString('latin1', 4, 8);
			let boxSize = header.readUInt32BE(0);
			if (boxSize === 1) {
				if (bytesRead < HEADER_BYTES + 8) return null;
				// 64-bit size. Node can't index past 2^53 anyway, and a media file
				// that large is not something to be rewriting.
				boxSize = Number(header.readBigUInt64BE(8));
			} else if (boxSize === 0) {
				// "extends to end of file" — only legal for the last box, so whatever
				// this is, nothing follows it.
				return type === 'moov' ? true : sawFtyp ? false : null;
			}

			// `ftyp` must lead an mp4. Without it this is some other container and
			// the whole question is meaningless.
			if (offset === 0) {
				if (type !== 'ftyp') return null;
				sawFtyp = true;
			}
			// The first of the two to appear decides it.
			if (type === 'moov') return true;
			if (type === 'mdat') return false;

			// A box can't be smaller than its own header. Continuing from a size
			// like that would resume reading at an offset inside the previous box,
			// where any four bytes that happen to spell `moov` would be taken as an
			// answer — a confident wrong one, off garbage. Better to say we don't
			// know. (It can't spin: a size of 0 is handled above, so the cursor
			// always advances.)
			if (boxSize < HEADER_BYTES) return null;
			offset += boxSize;
		}
		// Ran off the end having seen neither. Not something to rewrite blind.
		return null;
	} catch {
		return null;
	} finally {
		await handle.close().catch(() => {});
	}
}

/**
 * Rewrite `path` in place with its index at the front, returning the new byte
 * size — or null if nothing was done.
 *
 * Null covers both "didn't need it" and "couldn't do it", deliberately: every
 * caller's response is the same, which is to keep the file exactly as it was.
 * A video that can't be remuxed is still a perfectly good video.
 *
 * The replacement goes through a uniquely-named sibling and a rename, matching
 * every other write in this directory — a reader can never observe a half-built
 * file, and a crash leaves the original untouched. The output is checked for
 * being genuinely faststart before the swap, so a remux that ran cleanly but
 * didn't move the index can't overwrite a working file.
 *
 * That check bounds ONE property and is not a general "is this output sound"
 * gate: it walks top-level box headers, so it cannot see inside `moov` and
 * cannot tell whether the streams survived. Dropped tracks look identical to
 * it — which is why the stream selection is pinned explicitly at the argv
 * rather than left to ffmpeg's default. See `remuxArgs`.
 */
export async function makeFaststart(path: string): Promise<number | null> {
	if ((await isFaststart(path)) !== false) return null;

	let sourceBytes: number;
	try {
		sourceBytes = (await stat(path)).size;
	} catch {
		// isFaststart just read this file, so a failure here is the volume going
		// away between the two calls rather than a missing file. Either way the
		// answer is the same, and the next caller will find out.
		return null;
	}

	const budgetMs = remuxBudgetMs(sourceBytes);
	if (budgetMs === null) {
		log.warn(
			`declining ${path}: ${Math.round(sourceBytes / BYTES_PER_MB)} MB would not ` +
				`finish within ${REMUX_MAX_MS / 1000}s, leaving the index where it is`,
		);
		return null;
	}

	const tmp = `${path}.${process.pid}.${randomUUID()}.faststart.tmp`;
	try {
		// Bounded by a deadline the child cannot outlive (see ffmpeg.ts), which
		// matters more here than for a thumbnail: this runs inside
		// `persistGeneratedVideo`, inside the endpoint slot `runMediaRelay`
		// holds, so a child that never settles would hold a generation slot for
		// the life of the process — on a `max_concurrent = 1` endpoint, the whole
		// endpoint. It bounds the child only: the fs calls around it (`isFaststart`,
		// `stat`, `rename`, the caller's `putStream`) can't be deadlined, so if
		// MEDIA_DIR stops answering one of those may hang first. This covers
		// ffmpeg wedging on one inode while Node's own metadata calls still return.
		await runFfmpeg(remuxArgs(path, tmp), budgetMs, tmp);

		// Verify before swapping. A remux that ran cleanly and produced something
		// that isn't faststart means the assumption behind this whole module was
		// wrong for this file, and the original is the safer thing to keep.
		if ((await isFaststart(tmp)) !== true) {
			log.warn(`remux of ${path} did not produce a faststart file; keeping original`);
			await unlink(tmp).catch(() => {});
			return null;
		}
		const { size } = await stat(tmp);
		if (size === 0) {
			log.warn(`remux of ${path} produced an empty file; keeping original`);
			await unlink(tmp).catch(() => {});
			return null;
		}

		await rename(tmp, path);
		return size;
	} catch (e) {
		// A deadline means something on this volume stopped answering, so awaiting
		// an unlink against it would hang exactly the way the child did — and take
		// with it the slot release this whole mechanism exists to protect. Fire it
		// and move on; `runFfmpeg` has already arranged for the path to be
		// reclaimed if the child ever wakes up.
		//
		// Logged, not swallowed. The sibling module makes this argument directly
		// (see vision-variant.ts's readFileOrNull): a volume that has stopped
		// answering would otherwise degrade every file in silence. The same
		// applies to the likeliest cause by far — no `ffmpeg` on PATH, which
		// yields ENOENT here and would otherwise mean every video keeps its index
		// at the end with nothing anywhere to say so. This runs once per video,
		// never in a loop, so there is no log-volume argument against it.
		if (e instanceof FfmpegDeadline) {
			log.warn(`${path}: ${e.message}; keeping original`);
			void unlink(tmp).catch(() => {});
		} else {
			log.warn(`remux failed for ${path}, keeping original:`, e);
			await unlink(tmp).catch(() => {});
		}
		return null;
	}
}
