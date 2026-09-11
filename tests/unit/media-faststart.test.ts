/**
 * Detecting and fixing an mp4 whose index sits at the end of the file.
 *
 * The detector is tested against REAL byte layouts rather than a mock, because
 * what it does is read a container format — a mock of `fs` would only prove the
 * test and the code agree about a fiction. The boxes here are synthetic but
 * structurally honest: an 8-byte header of size-then-type, laid out in the
 * orders an encoder actually produces.
 *
 * `makeFaststart`'s ffmpeg call IS mocked. Whether ffmpeg can move a moov atom
 * is ffmpeg's business and was verified against the real binary; what's ours is
 * everything around it — the skip when the file is already correct, the refusal
 * to swap in an output that didn't come out faststart, and the rule that any
 * failure leaves the original untouched.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Buffer } from 'node:buffer';

type FfmpegOutcome = 'faststart' | 'not-faststart' | 'empty' | 'fail';

const state = vi.hoisted(() => ({
	dir: '',
	outcome: 'faststart' as FfmpegOutcome,
	calls: [] as string[][],
}));

vi.mock('node:child_process', () => ({
	execFile: (
		_file: string,
		args: string[],
		_opts: Record<string, unknown>,
		cb: (err: Error | null, r?: { stdout: string; stderr: string }) => void,
	) => {
		state.calls.push(args);
		const out = args[args.length - 1];
		if (state.outcome === 'fail') {
			cb(new Error('ffmpeg: Invalid data found when processing input'));
			return;
		}
		if (state.outcome === 'empty') {
			writeFileSync(out, Buffer.alloc(0));
		} else if (state.outcome === 'faststart') {
			writeFileSync(out, mp4(['ftyp', 'moov', 'mdat']));
		} else {
			// Ran clean and produced something still wrong — the case the verify
			// step exists for.
			writeFileSync(out, mp4(['ftyp', 'mdat', 'moov']));
		}
		cb(null, { stdout: '', stderr: '' });
	},
}));

const { isFaststart, makeFaststart } = await import('$lib/server/media/faststart');

/** A structurally valid top-level box chain. Bodies are zero-filled — the
 *  detector only ever reads headers, which is the property being pinned. */
function mp4(types: readonly string[], bodyBytes = 32): Buffer {
	return Buffer.concat(
		types.map((t) => {
			const box = Buffer.alloc(8 + bodyBytes);
			box.writeUInt32BE(8 + bodyBytes, 0);
			box.write(t, 4, 'latin1');
			return box;
		}),
	);
}

function write(name: string, bytes: Buffer): string {
	const p = join(state.dir, name);
	writeFileSync(p, bytes);
	return p;
}

beforeEach(() => {
	state.dir = mkdtempSync(join(tmpdir(), 'gs-faststart-'));
	state.outcome = 'faststart';
	state.calls = [];
});

afterEach(() => {
	rmSync(state.dir, { recursive: true, force: true });
});

describe('isFaststart', () => {
	it('reports true when the index precedes the samples', async () => {
		expect(await isFaststart(write('a.mp4', mp4(['ftyp', 'moov', 'mdat'])))).toBe(true);
	});

	it('reports false when the samples come first', async () => {
		// What ComfyUI writes, and the whole reason this module exists.
		expect(await isFaststart(write('b.mp4', mp4(['ftyp', 'free', 'mdat', 'moov'])))).toBe(false);
	});

	it('walks past boxes it does not care about rather than stopping', async () => {
		expect(
			await isFaststart(write('c.mp4', mp4(['ftyp', 'free', 'wide', 'skip', 'moov', 'mdat']))),
		).toBe(true);
	});

	it('reads only headers, not bodies', async () => {
		// The property that makes this cheap enough to run on every file: a 200 MB
		// video costs the same handful of reads as a tiny one. A detector that
		// scanned for the string would have to read the whole thing.
		const huge = mp4(['ftyp', 'moov', 'mdat'], 4 * 1024 * 1024);
		expect(huge.byteLength).toBeGreaterThan(12 * 1024 * 1024);
		expect(await isFaststart(write('d.mp4', huge))).toBe(true);
	});

	it('returns null for a container that is not mp4 at all', async () => {
		// Matroska/WebM: no ftyp, and the question is meaningless. Callers must
		// leave these alone rather than treat "not faststart" as "needs fixing".
		expect(await isFaststart(write('e.webm', Buffer.from('\x1a\x45\xdf\xa3rest', 'latin1')))).toBe(
			null,
		);
	});

	it('will not answer from a misaligned read after a malformed box size', async () => {
		// The guard's real job — it is not about looping (a size of 0 is handled
		// separately, so the cursor always advances). It is that resuming from a
		// sub-header size lands mid-box, where any four bytes spelling `moov` read
		// as an answer. This file is built so exactly that happens: box 2 declares
		// size 3, and three bytes on, the header position spells `moov`.
		//
		// The malformed box must be one the walker STEPS PAST — `moov` and `mdat`
		// are decisive on sight, so a bad size on either is never reached.
		const bad = Buffer.alloc(32);
		bad.writeUInt32BE(8, 0);
		bad.write('ftyp', 4, 'latin1');
		bad.writeUInt32BE(3, 8); // smaller than a header
		bad.write('xxxm', 12, 'latin1'); // resuming at 8+3=11 reads type from 15
		bad.write('oov', 16, 'latin1'); // ...so bytes 15-18 spell "moov"
		expect(bad.toString('latin1', 15, 19)).toBe('moov'); // the trap is armed

		expect(await isFaststart(write('f.mp4', bad))).toBe(null);
	});

	it('returns null for a missing file instead of throwing', async () => {
		expect(await isFaststart(join(state.dir, 'nope.mp4'))).toBe(null);
	});
});

describe('makeFaststart', () => {
	it('rewrites a file whose index is at the end, and reports the new size', async () => {
		const p = write('in.mp4', mp4(['ftyp', 'mdat', 'moov']));
		const size = await makeFaststart(p);

		expect(size).not.toBeNull();
		expect(await isFaststart(p)).toBe(true);
		expect(size).toBe(readFileSync(p).byteLength);
	});

	it('does no work at all on a file that is already faststart', async () => {
		// Remuxing unconditionally would rewrite every correct file — real cost on
		// a library of large videos, for nothing.
		const original = mp4(['ftyp', 'moov', 'mdat']);
		const p = write('ok.mp4', original);

		expect(await makeFaststart(p)).toBeNull();
		expect(state.calls).toHaveLength(0);
		expect(readFileSync(p).equals(original)).toBe(true);
	});

	it('leaves a non-mp4 alone', async () => {
		const original = Buffer.from('\x1a\x45\xdf\xa3matroska', 'latin1');
		const p = write('v.webm', original);

		expect(await makeFaststart(p)).toBeNull();
		expect(state.calls).toHaveLength(0);
		expect(readFileSync(p).equals(original)).toBe(true);
	});

	it('keeps the original when ffmpeg fails', async () => {
		state.outcome = 'fail';
		const original = mp4(['ftyp', 'mdat', 'moov']);
		const p = write('bad.mp4', original);

		expect(await makeFaststart(p)).toBeNull();
		expect(readFileSync(p).equals(original)).toBe(true);
	});

	it('refuses to swap in an output that is not actually faststart', async () => {
		// The verify step. A remux that exits clean but produces the same layout
		// means the premise was wrong for this file; overwriting a working video
		// with it would be a silent downgrade.
		state.outcome = 'not-faststart';
		const original = mp4(['ftyp', 'mdat', 'moov']);
		const p = write('nope.mp4', original);

		expect(await makeFaststart(p)).toBeNull();
		expect(readFileSync(p).equals(original)).toBe(true);
	});

	it('refuses to swap in an empty output', async () => {
		state.outcome = 'empty';
		const original = mp4(['ftyp', 'mdat', 'moov']);
		const p = write('zero.mp4', original);

		expect(await makeFaststart(p)).toBeNull();
		expect(readFileSync(p).equals(original)).toBe(true);
	});

	it('leaves no temp file behind on any failure path', async () => {
		state.outcome = 'fail';
		await makeFaststart(write('t1.mp4', mp4(['ftyp', 'mdat', 'moov'])));
		state.outcome = 'not-faststart';
		await makeFaststart(write('t2.mp4', mp4(['ftyp', 'mdat', 'moov'])));

		expect(readdirSync(state.dir).filter((f) => f.includes('.faststart.tmp'))).toEqual([]);
	});

	it('copies streams rather than re-encoding', async () => {
		// A re-encode would cost generation loss and minutes of CPU. `-c copy` is
		// the difference between this being a file rewrite and a transcode.
		await makeFaststart(write('args.mp4', mp4(['ftyp', 'mdat', 'moov'])));

		const args = state.calls[0];
		expect(args).toContain('-c');
		expect(args[args.indexOf('-c') + 1]).toBe('copy');
		expect(args[args.indexOf('-movflags') + 1]).toBe('+faststart');
		// Written to a sibling temp, never over the input.
		expect(args[args.length - 1]).toMatch(/\.faststart\.tmp$/);
		expect(existsSync(args[args.length - 1])).toBe(false);
	});

	it('takes every stream, minus the ones mp4 cannot hold', async () => {
		// The one argument in this list whose absence is SILENT. Without `-map`,
		// ffmpeg's default stream selection keeps one video and one audio and
		// discards the rest — exit 0, a genuinely faststart output, and then the
		// rename destroys the original. Measured against the shipped build, a
		// two-audio mp4 lost a track and 36% of its bytes, and a two-subtitle file
		// lost both subtitle tracks as well.
		//
		// `-map 0` on its own is not sufficient and not safe to "simplify" to: a
		// camera original with a timecode track exposes it as `data / codec none`,
		// which the mp4 muxer rejects outright (exit 234) — stock ffmpeg does the
		// same, so it is the container, not our build. Dropping data streams keeps
		// everything else, and the muxer rebuilds tmcd from the timecode tag.
		await makeFaststart(write('map.mp4', mp4(['ftyp', 'mdat', 'moov'])));

		const args = state.calls[0];
		const maps = args.reduce<string[]>(
			(acc, a, i) => (a === '-map' ? [...acc, args[i + 1]] : acc),
			[],
		);
		expect(maps).toEqual(['0', '-0:d']);
		// Order matters: the exclusion has to follow the inclusion it narrows.
		expect(args.indexOf('-map')).toBeLessThan(args.lastIndexOf('-map'));
		// And it must precede the output, or ffmpeg reads it as an input option.
		expect(args.lastIndexOf('-map')).toBeLessThan(args.length - 1);
	});
});
