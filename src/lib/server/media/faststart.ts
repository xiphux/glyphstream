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
 * being genuinely faststart before the swap, so a remux that silently produced
 * something wrong can't overwrite a working file.
 */
export async function makeFaststart(path: string): Promise<number | null> {
	if ((await isFaststart(path)) !== false) return null;

	const tmp = `${path}.${process.pid}.${randomUUID()}.faststart.tmp`;
	try {
		await execFileAsync(
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
	} catch {
		await unlink(tmp).catch(() => {});
		return null;
	}
}
