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
 * back untouched, so there is no generation loss and no decode. The cost is one
 * pass over the bytes, and the byte count changes slightly because sample
 * offsets inside `moov` have to be rewritten for its new position.
 *
 * Why here and not in the bridge that fetches from ComfyUI: the bridge
 * normalizes API differences and passes artifacts through verbatim — it has
 * never rewritten one, and it never plays anything either. Faststart is purely
 * a viewing concern, and this is where viewing happens. It also covers every
 * provider rather than one adapter, and the permanent copy lives here.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { open, rename, stat, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import process from 'node:process';
import { Buffer } from 'node:buffer';

const execFileAsync = promisify(execFile);

/** Long enough that a stalled remux can't hold anything hostage, generous
 *  enough for a large file on slow storage: this is one linear pass, not a
 *  decode, so it is I/O bound rather than CPU bound. */
const REMUX_TIMEOUT_MS = 120_000;

/** How long past `REMUX_TIMEOUT_MS` to wait before giving up on the child
 *  settling at all. Non-zero so the ordinary case — SIGKILL lands, execFile
 *  rejects — still surfaces ffmpeg's own error rather than ours. */
const REMUX_REAP_GRACE_MS = 2_000;

/**
 * Our own deadline expiring, as opposed to ffmpeg failing.
 *
 * `execFile`'s `timeout` bounds when the KILL SIGNAL IS SENT, not when the
 * promise settles — its callback runs off the child's `close` event, and the
 * only path from the timeout to that callback is `child.kill()` itself
 * throwing. A process blocked in uninterruptible I/O cannot be reaped, so the
 * promise never settles. That matters more here than at the sibling call in
 * `thumbnail.ts`: this runs inside `persistGeneratedVideo`, which runs inside
 * the endpoint slot held by `startMediaRelay` — so a child that never settles
 * holds a generation slot for the life of the process, and on a
 * `max_concurrent = 1` endpoint that is the whole endpoint.
 *
 * Racing an independent timer means the slot comes back whether or not the
 * child ever does. It does NOT reap the child; nothing in Node can.
 *
 * Bounds the CHILD, and only the child. The `open`/`stat`/`read` in
 * `isFaststart`, the `stat`/`rename` in `makeFaststart`, and `putStream` in
 * its caller are all un-deadlined libuv fs calls against the same volume — if
 * MEDIA_DIR stops answering, one of those hangs before ffmpeg is ever spawned.
 * Fixing that is a different change (a deadline can't wrap a libuv fs call);
 * this covers the case where ffmpeg specifically wedges on one inode while
 * Node's own metadata ops still complete.
 */
class RemuxDeadline extends Error {
	constructor(seconds: number) {
		super(`ffmpeg did not settle within ${seconds}s`);
		this.name = 'RemuxDeadline';
	}
}

/**
 * Run the remux, bounded by a deadline the child cannot outlive.
 *
 * Resolves when ffmpeg does; rejects with `RemuxDeadline` if it doesn't in
 * time. On the deadline path the temp file is reclaimed whenever the child
 * finally settles, if it ever does — see the caller for why that can't just be
 * awaited.
 */
async function runRemux(path: string, tmp: string): Promise<void> {
	const run = execFileAsync(
		'ffmpeg',
		[
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
			// one. Excluding data streams keeps the rest: the mov muxer regenerates a
			// tmcd track from the timecode metadata tag anyway, so the stream count
			// survives the round trip.
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
		],
		{
			timeout: REMUX_TIMEOUT_MS,
			killSignal: 'SIGKILL',
			maxBuffer: 1024 * 1024,
			env: { PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin' },
		},
	);

	// Attached before the race so a rejection arriving after we've given up is
	// already handled and can't surface as an unhandled rejection.
	run.catch(() => {});

	let timer: ReturnType<typeof setTimeout> | undefined;
	const deadline = new Promise<never>((_, reject) => {
		timer = setTimeout(
			() => reject(new RemuxDeadline((REMUX_TIMEOUT_MS + REMUX_REAP_GRACE_MS) / 1000)),
			REMUX_TIMEOUT_MS + REMUX_REAP_GRACE_MS,
		);
		// Don't hold the event loop open. The awaited promise is what keeps the
		// work alive; without this, a shutdown during an in-flight remux waits out
		// the full remaining timer.
		timer.unref?.();
	});

	try {
		await Promise.race([run, deadline]);
	} catch (e) {
		if (e instanceof RemuxDeadline) {
			// We have given up on this child, but it may still be alive and may yet
			// finish writing `tmp`. Nothing will ever reference that path again and
			// nothing sweeps for it, so reclaim it whenever the child settles. Not
			// awaited: the point of the deadline is that this may be never.
			void run.finally(() => unlink(tmp).catch(() => {})).catch(() => {});
		}
		throw e;
	} finally {
		clearTimeout(timer);
	}
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
 * rather than left to ffmpeg's default. See `runRemux`.
 */
export async function makeFaststart(path: string): Promise<number | null> {
	if ((await isFaststart(path)) !== false) return null;

	const tmp = `${path}.${process.pid}.${randomUUID()}.faststart.tmp`;
	try {
		await runRemux(path, tmp);

		// Verify before swapping. A remux that ran cleanly and produced something
		// that isn't faststart means the assumption behind this whole module was
		// wrong for this file, and the original is the safer thing to keep.
		if ((await isFaststart(tmp)) !== true) {
			await unlink(tmp).catch(() => {});
			return null;
		}
		const { size } = await stat(tmp);
		if (size === 0) {
			await unlink(tmp).catch(() => {});
			return null;
		}

		await rename(tmp, path);
		return size;
	} catch (e) {
		// A deadline means something on this volume stopped answering, so awaiting
		// an unlink against it would hang exactly the way the child did — and take
		// with it the slot release this whole mechanism exists to protect. Fire it
		// and move on; `runRemux` has already arranged for the path to be
		// reclaimed if the child ever wakes up.
		if (e instanceof RemuxDeadline) {
			void unlink(tmp).catch(() => {});
		} else {
			await unlink(tmp).catch(() => {});
		}
		return null;
	}
}
