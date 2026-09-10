/**
 * Video gallery thumbnails — the ffmpeg half of thumbnail.ts.
 *
 * ffmpeg is mocked rather than executed. What's ours is the invocation and the
 * fallbacks around it: whether a video takes the ffmpeg path at all, what gets
 * asked of it, and — the parts with teeth — that a clip too short to seek into
 * still produces a tile, and that a decode failure comes back as null instead of
 * escaping into the request. Whether ffmpeg itself can turn an mp4 into a JPEG is
 * ffmpeg's business, verified against real files when the build was chosen.
 *
 * The mocked binary WRITES A FILE, because the code deliberately doesn't trust
 * the exit status: ffmpeg reports "seek landed past the end" by exiting 0 having
 * written nothing at all, so an empty output is a distinct outcome from a
 * failure and both have to be reachable here.
 *
 * Isolation note: the module keeps a process-wide `failed` set, and these tests
 * share one storage path. They don't interfere because the set is keyed on the
 * ABSOLUTE thumb path and `beforeEach` mints a fresh DERIVED_DIR, so every test
 * gets its own key space. Point the temp dirs at one shared location to "tidy
 * up" and a failure recorded by one test starts short-circuiting the next.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

type FfmpegOutcome = 'ok' | 'empty' | 'fail';

/** What `promisify` hands execFile as its final argument. */
type ExecFileCallback = (err: Error | null, result?: { stdout: string; stderr: string }) => void;

const state = vi.hoisted(() => ({
	media: '',
	derived: '',
	/** Every invocation, in order, so the arguments can be asserted. */
	calls: [] as Array<{ args: string[]; opts: Record<string, unknown> }>,
	/** Consumed one per invocation; the last entry repeats once exhausted. */
	outcomes: ['ok'] as FfmpegOutcome[],
	sharpCalls: 0,
}));

vi.mock('$lib/server/env', () => ({
	mediaDir: () => state.media,
	derivedDir: () => state.derived,
}));

// Callback-style on purpose: thumbnail.ts wraps this in `promisify`, and a bare
// vi.fn carries no util.promisify.custom, so promisify uses the generic
// (…args, callback) contract. Mocking it as a promise would silently never be
// awaited.
vi.mock('node:child_process', () => ({
	execFile: (
		_file: string,
		args: string[],
		opts: Record<string, unknown>,
		cb: ExecFileCallback,
	) => {
		state.calls.push({ args, opts });
		const outcome = state.outcomes[Math.min(state.calls.length - 1, state.outcomes.length - 1)];
		const out = args[args.length - 1];
		if (outcome === 'fail') {
			cb(new Error('ffmpeg: Invalid data found when processing input'));
			return;
		}
		if (outcome === 'ok') {
			mkdirSync(dirname(out), { recursive: true });
			writeFileSync(out, Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00]));
		}
		// 'empty' writes nothing and still exits cleanly — the short-clip case.
		cb(null, { stdout: '', stderr: '' });
	},
}));

vi.mock('sharp', () => ({
	default: () => {
		state.sharpCalls++;
		const chain = {
			resize: () => chain,
			jpeg: () => chain,
			toFile: (p: string) => {
				mkdirSync(dirname(p), { recursive: true });
				writeFileSync(p, 'image-thumb-bytes');
				return Promise.resolve();
			},
		};
		return chain;
	},
}));

const { getOrCreateThumbnail, thumbStoragePath, FAILED_TTL_MS } =
	await import('$lib/server/media/thumbnail');

const VIDEO_PATH = 'ab/cd/clip.mp4';

function writeSource(storagePath: string): void {
	const abs = resolve(state.media, storagePath);
	mkdirSync(dirname(abs), { recursive: true });
	writeFileSync(abs, 'pretend-this-is-an-mp4');
}

function argAfter(call: { args: string[] }, flag: string): string | undefined {
	const i = call.args.indexOf(flag);
	return i === -1 ? undefined : call.args[i + 1];
}

beforeEach(() => {
	state.media = mkdtempSync(join(tmpdir(), 'gs-vt-media-'));
	state.derived = mkdtempSync(join(tmpdir(), 'gs-vt-derived-'));
	state.calls = [];
	state.outcomes = ['ok'];
	state.sharpCalls = 0;
});

afterEach(() => {
	rmSync(state.media, { recursive: true, force: true });
	rmSync(state.derived, { recursive: true, force: true });
});

describe('video thumbnails', () => {
	it('decodes with ffmpeg and never touches sharp', async () => {
		writeSource(VIDEO_PATH);
		const thumb = await getOrCreateThumbnail(VIDEO_PATH, 'video');

		expect(thumb).not.toBeNull();
		expect(state.calls).toHaveLength(1);
		expect(state.sharpCalls).toBe(0);
		// Same name, same root, same content type as an image thumb — a video tile
		// is not a second kind of cached artifact, it is the same one.
		expect(thumb!.absolutePath).toBe(resolve(state.derived, thumbStoragePath(VIDEO_PATH)));
		expect(thumb!.contentType).toBe('image/jpeg');
	});

	it('still routes images through sharp', async () => {
		writeSource('ab/cd/pic.png');
		const thumb = await getOrCreateThumbnail('ab/cd/pic.png', 'image');

		expect(thumb).not.toBeNull();
		expect(state.sharpCalls).toBe(1);
		expect(state.calls).toHaveLength(0);
	});

	it('seeks past the opening frame, and caps the long side without enlarging', async () => {
		writeSource(VIDEO_PATH);
		await getOrCreateThumbnail(VIDEO_PATH, 'video');

		const call = state.calls[0];
		// -ss must precede -i: after it, ffmpeg decodes everything up to the
		// timestamp and throws it away, which on a long clip is the whole file.
		expect(call.args.indexOf('-ss')).toBeLessThan(call.args.indexOf('-i'));
		expect(argAfter(call, '-ss')).toBe('0.1');
		expect(argAfter(call, '-frames:v')).toBe('1');

		// `min(512,iw)` on BOTH axes is what prevents upscaling a small video;
		// force_original_aspect_ratio=decrease is what preserves the aspect. Drop
		// either and the output stops matching what sharp does for images.
		const vf = argAfter(call, '-vf')!;
		expect(vf).toContain("w='min(512,iw)'");
		expect(vf).toContain("h='min(512,ih)'");
		expect(vf).toContain('force_original_aspect_ratio=decrease');

		// The muxer can't be inferred from a path ending in `.tmp`.
		expect(argAfter(call, '-f')).toBe('image2');
	});

	it('bounds the decode so one bad file cannot hold a generation slot forever', async () => {
		writeSource(VIDEO_PATH);
		await getOrCreateThumbnail(VIDEO_PATH, 'video');

		// There are only three slots. Without a timeout, three files that make
		// ffmpeg spin stop the gallery generating anything at all — images too,
		// since both kinds share the semaphore.
		expect(state.calls[0].opts.timeout).toBeGreaterThan(0);
		expect(state.calls[0].opts.killSignal).toBe('SIGKILL');

		// Time is not the only unbounded resource. sharp refuses a decompression
		// bomb via its default limitInputPixels; ffmpeg has no such default, and
		// allocates the frame before `scale` ever runs. Must precede -i to be in
		// force while the decoder opens the input.
		const call = state.calls[0];
		expect(argAfter(call, '-max_pixels')).toBe('268435456');
		expect(call.args.indexOf('-max_pixels')).toBeLessThan(call.args.indexOf('-i'));
	});

	it('retries at frame zero when the seek lands past the end of a short clip', async () => {
		// The case that has no error to catch: ffmpeg exits 0 and writes nothing.
		state.outcomes = ['empty', 'ok'];
		writeSource(VIDEO_PATH);

		const thumb = await getOrCreateThumbnail(VIDEO_PATH, 'video');

		expect(thumb).not.toBeNull();
		expect(state.calls).toHaveLength(2);
		expect(argAfter(state.calls[0], '-ss')).toBe('0.1');
		expect(argAfter(state.calls[1], '-ss')).toBe('0');
	});

	it('does not retry when the first attempt actually failed', async () => {
		// Only an EMPTY output earns a retry (a clip shorter than the seek). When
		// ffmpeg throws — undecodable input, no such binary, a timeout kill —
		// re-running the identical decode at a different -ss reaches the same
		// answer, so the retry only doubles the work and doubles the worst-case
		// hold on a generation slot. It also buries ffmpeg's real stderr behind a
		// second, less informative failure.
		state.outcomes = ['fail', 'ok'];
		writeSource(VIDEO_PATH);

		await expect(getOrCreateThumbnail(VIDEO_PATH, 'video')).resolves.toBeNull();
		expect(state.calls).toHaveLength(1);
	});

	it('returns null rather than throwing when the file cannot be decoded', async () => {
		state.outcomes = ['fail'];
		writeSource(VIDEO_PATH);

		// Both entry points reach this from a request — the gallery tile endpoint
		// and the poster on a chat message. A throw here is a 500 on a page that
		// was otherwise fine.
		await expect(getOrCreateThumbnail(VIDEO_PATH, 'video')).resolves.toBeNull();
		expect(existsSync(resolve(state.derived, thumbStoragePath(VIDEO_PATH)))).toBe(false);
	});

	it('leaves no .tmp behind when both attempts fail', async () => {
		state.outcomes = ['empty', 'empty'];
		writeSource(VIDEO_PATH);

		await expect(getOrCreateThumbnail(VIDEO_PATH, 'video')).resolves.toBeNull();
		// A failed generation that stranded its temp file would leak one per
		// attempt, on every gallery view, forever — nothing sweeps DERIVED_DIR.
		const shard = resolve(state.derived, dirname(thumbStoragePath(VIDEO_PATH)));
		const leftovers = existsSync(shard) ? readdirSync(shard).filter((f) => f.endsWith('.tmp')) : [];
		expect(leftovers).toEqual([]);
	});

	it('does not re-decode a source that already failed', async () => {
		// The gallery is virtualized, so scrolling a tile out of view and back
		// re-creates the <video> and re-requests its poster. Without a memo that is
		// a fresh ffmpeg spawn every time, forever, for a file that will never
		// decode — and the two permanent cases are ordinary: a container outside
		// the shipped demuxers, and no ffmpeg on PATH at all.
		state.outcomes = ['fail'];
		writeSource(VIDEO_PATH);

		await expect(getOrCreateThumbnail(VIDEO_PATH, 'video')).resolves.toBeNull();
		const afterFirst = state.calls.length;
		expect(afterFirst).toBeGreaterThan(0);

		await expect(getOrCreateThumbnail(VIDEO_PATH, 'video')).resolves.toBeNull();
		await expect(getOrCreateThumbnail(VIDEO_PATH, 'video')).resolves.toBeNull();
		expect(state.calls).toHaveLength(afterFirst);
	});

	it('still retries a source that was merely missing', async () => {
		// The one failure that routinely un-fails itself: a row can be ahead of its
		// bytes mid-write, and a network-mounted MEDIA_DIR can stat-fail for a
		// mount that comes back. Remembering it would strand the media permanently
		// for the life of the process, so this case must NOT be memoized.
		await expect(getOrCreateThumbnail('zz/zz/later.mp4', 'video')).resolves.toBeNull();
		expect(state.calls).toHaveLength(0); // never reached ffmpeg

		writeSource('zz/zz/later.mp4');
		const thumb = await getOrCreateThumbnail('zz/zz/later.mp4', 'video');
		expect(thumb).not.toBeNull();
	});

	it('forgets a failure once its TTL lapses', async () => {
		// The memo must not be permanent. Both encoders WRITE their output as part
		// of encoding, so a full or read-only DERIVED_DIR throws from inside the
		// decode step and is indistinguishable from a bad codec. Remembering that
		// forever strands a perfectly good source until someone restarts the
		// process — and on the image path the endpoint would go on serving
		// full-resolution originals under a year-long immutable cache.
		state.outcomes = ['fail'];
		writeSource(VIDEO_PATH);
		await expect(getOrCreateThumbnail(VIDEO_PATH, 'video')).resolves.toBeNull();
		expect(state.calls).toHaveLength(1);

		vi.useFakeTimers();
		try {
			vi.setSystemTime(Date.now() + FAILED_TTL_MS + 1);
			state.outcomes = ['ok'];
			const thumb = await getOrCreateThumbnail(VIDEO_PATH, 'video');
			expect(thumb).not.toBeNull();
			expect(state.calls).toHaveLength(2);
		} finally {
			vi.useRealTimers();
		}
	});

	it('does not remember a failure that came from the storage, not the source', async () => {
		// mkdir/rename/stat failing says something about the volume, and the volume
		// gets fixed. Simulated with a DERIVED_DIR whose parent is a regular file,
		// so mkdir throws ENOTDIR before any decode is attempted — if that were
		// memoized, repairing the volume wouldn't bring the thumbnail back.
		// DERIVED_DIR stays PUT across both calls — the memo is keyed on the
		// absolute thumb path, so repointing it would silently change the key and
		// the assertion would hold whether or not the guard exists. Instead the
		// thumb's own shard is blocked by a regular file, which is repairable in
		// place.
		const shard = resolve(state.derived, dirname(thumbStoragePath(VIDEO_PATH)));
		mkdirSync(dirname(shard), { recursive: true });
		writeFileSync(shard, 'a file where the shard directory needs to be');
		vi.spyOn(console, 'warn').mockImplementation(() => {});
		writeSource(VIDEO_PATH);

		await expect(getOrCreateThumbnail(VIDEO_PATH, 'video')).resolves.toBeNull();
		expect(state.calls).toHaveLength(0); // mkdir threw before any decode

		// Volume repaired, same path as before. The very next request must retry.
		rmSync(shard);
		const thumb = await getOrCreateThumbnail(VIDEO_PATH, 'video');
		expect(thumb).not.toBeNull();
		expect(state.calls).toHaveLength(1);
		vi.restoreAllMocks();
	});

	it('lets a thumbnail that appears later win over a remembered failure', async () => {
		// The memo is consulted AFTER the disk probe, so a backfill or a restored
		// DERIVED_DIR is picked up rather than shadowed by a stale entry.
		state.outcomes = ['fail'];
		writeSource(VIDEO_PATH);
		await expect(getOrCreateThumbnail(VIDEO_PATH, 'video')).resolves.toBeNull();

		const thumbAbs = resolve(state.derived, thumbStoragePath(VIDEO_PATH));
		mkdirSync(dirname(thumbAbs), { recursive: true });
		writeFileSync(thumbAbs, Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00]));

		const thumb = await getOrCreateThumbnail(VIDEO_PATH, 'video');
		expect(thumb).not.toBeNull();
		expect(thumb!.absolutePath).toBe(thumbAbs);
	});

	it('serves the cached frame without invoking ffmpeg again', async () => {
		writeSource(VIDEO_PATH);
		await getOrCreateThumbnail(VIDEO_PATH, 'video');
		await getOrCreateThumbnail(VIDEO_PATH, 'video');

		// The whole point of the cache: a gallery of videos costs one decode each,
		// once, not one per view.
		expect(state.calls).toHaveLength(1);
	});
});
