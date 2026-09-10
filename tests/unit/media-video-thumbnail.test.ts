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
 * the exit status — and cannot, because ffmpeg changed it. Asked to seek past
 * the end of a clip, ffmpeg 5 and 6 exit 0 having written nothing while ffmpeg 7
 * exits non-zero, and both generations are deployable (the image pins 7;
 * docs/deployment.md supports a system ffmpeg on PATH). So the mock models exit
 * status and output as INDEPENDENT axes, which is the whole point of the code
 * under test.
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

/** 'empty' is ffmpeg 5/6 reporting a seek past the end: exit 0, no output.
 *  'fail' is ffmpeg 7 reporting the SAME situation, and also a genuinely
 *  undecodable file: non-zero exit, no output. 'timeout' is a kill. */
type FfmpegOutcome = 'ok' | 'empty' | 'fail' | 'timeout' | 'maxbuffer' | 'partial-then-fail';

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
	sharpFails: false,
	/** Fake-clock ms each ffmpeg invocation should appear to consume. */
	advanceMs: 0,
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
		if (state.advanceMs > 0) vi.advanceTimersByTime(state.advanceMs);
		const outcome = state.outcomes[Math.min(state.calls.length - 1, state.outcomes.length - 1)];
		const out = args[args.length - 1];
		if (outcome === 'maxbuffer') {
			// Node's shape for this: killed by the SAME signal a timeout uses.
			cb(
				Object.assign(new Error('stdout maxBuffer length exceeded'), {
					killed: true,
					signal: 'SIGKILL',
					code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER',
				}),
			);
			return;
		}
		if (outcome === 'partial-then-fail') {
			// Wrote bytes, then failed — the ENOSPC-mid-write shape.
			mkdirSync(dirname(out), { recursive: true });
			writeFileSync(out, Buffer.from([0xff, 0xd8]));
			cb(new Error('ffmpeg: No space left on device'));
			return;
		}
		if (outcome === 'timeout') {
			cb(Object.assign(new Error('ffmpeg killed'), { killed: true, signal: 'SIGKILL' }));
			return;
		}
		if (outcome === 'fail') {
			cb(new Error('ffmpeg: Nothing was written into output file'));
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
				if (state.sharpFails) return Promise.reject(new Error('sharp: unsupported image'));
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
	state.sharpFails = false;
	state.advanceMs = 0;
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
		// 8K, not sharp's ~268 MP: a video decoder holds several reference frames,
		// so the image-side number is an order of magnitude too generous here.
		expect(argAfter(call, '-max_pixels')).toBe('33177600');
		expect(call.args.indexOf('-max_pixels')).toBeLessThan(call.args.indexOf('-i'));

		// One frame needs one thread; the default is the core count, times three
		// concurrent slots, on a box shared with model inference.
		expect(argAfter(call, '-threads')).toBe('1');

		// Matters outside the shipped image, where a distro ffmpeg carries every
		// demuxer and protocol and the input is an uninspected upload.
		expect(argAfter(call, '-protocol_whitelist')).toBe('file');
		expect(call.args.indexOf('-protocol_whitelist')).toBeLessThan(call.args.indexOf('-i'));

		// The decoder has no business seeing AUTH_SECRET or the endpoint tokens.
		const env = call.opts.env as Record<string, string> | undefined;
		expect(env).toBeDefined();
		expect(Object.keys(env!)).toEqual(['PATH']);
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

	it('retries when a NON-ZERO exit produced no frame, which is how ffmpeg 7 reports a short clip', async () => {
		// The regression this guards. Keying the retry on "exited 0 with no
		// output" was correct for ffmpeg 5 and 6 and became dead code on 7, which
		// reports the same seek-past-end as exit 234. A clip shorter than the seek
		// then got no thumbnail at all — the one case the retry exists for.
		state.outcomes = ['fail', 'ok'];
		writeSource(VIDEO_PATH);

		const thumb = await getOrCreateThumbnail(VIDEO_PATH, 'video');
		expect(thumb).not.toBeNull();
		expect(state.calls).toHaveLength(2);
		expect(argAfter(state.calls[1], '-ss')).toBe('0');
	});

	it('shares one timeout budget across both attempts', async () => {
		// The semaphore shares three slots with the image path on the stated
		// grounds that video is bounded by FFMPEG_TIMEOUT_MS. That was only true
		// per attempt: a file that burned most of the budget and then errored used
		// to get a second full one, holding a slot for about twice the number the
		// comment names.
		vi.useFakeTimers();
		try {
			state.outcomes = ['fail', 'ok'];
			// Each invocation "takes" 5s of the shared budget.
			state.advanceMs = 5_000;
			writeSource(VIDEO_PATH);

			await getOrCreateThumbnail(VIDEO_PATH, 'video');
			expect(state.calls).toHaveLength(2);
			const first = state.calls[0].opts.timeout as number;
			const second = state.calls[1].opts.timeout as number;
			// Strictly less, by what the first attempt consumed — not a fresh budget.
			expect(second).toBe(first - 5_000);
		} finally {
			vi.useRealTimers();
		}
	});

	it('classifies a maxBuffer overrun as a retryable no-frame, not a timeout', async () => {
		// Node kills a maxBuffer overrun with the same signal it uses for a
		// timeout, so treating `killed` as decisive would deny the retry to a
		// damaged-but-decodable stream that merely logged too much on stderr.
		state.outcomes = ['maxbuffer', 'ok'];
		writeSource(VIDEO_PATH);

		const thumb = await getOrCreateThumbnail(VIDEO_PATH, 'video');
		expect(thumb).not.toBeNull();
		expect(state.calls).toHaveLength(2);
	});

	it('clears the temp file between attempts', async () => {
		// The first attempt can write bytes and still fail (ENOSPC mid-write on
		// DERIVED_DIR). If the second then exits 0 having written nothing — ffmpeg
		// 5/6's short-clip report — the stat would see the first attempt's partial
		// JPEG and rename a truncated frame into a year-long immutable cache.
		state.outcomes = ['partial-then-fail', 'empty'];
		writeSource(VIDEO_PATH);
		vi.spyOn(console, 'warn').mockImplementation(() => {});

		await expect(getOrCreateThumbnail(VIDEO_PATH, 'video')).resolves.toBeNull();
		expect(existsSync(resolve(state.derived, thumbStoragePath(VIDEO_PATH)))).toBe(false);
		vi.restoreAllMocks();
	});

	it('does not retry a timeout', async () => {
		// The one failure where a retry is expensive rather than cheap: it re-pays
		// the whole budget to reach the same place, and doubles how long one file
		// can hold a generation slot the image path also draws from. An ordinary
		// decode failure is milliseconds, so retrying that is nearly free.
		state.outcomes = ['timeout', 'ok'];
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

	it('does not memoize an IMAGE failure', async () => {
		// The memo pays for itself against a subprocess, not against sharp — and on
		// the image path it would do harm: a memoized image falls back to streaming
		// the full-resolution original, which the endpoint serves immutable for a
		// year, so ten minutes of suppression pins multi-MB originals in client
		// caches long after the server recovered.
		state.sharpFails = true;
		writeSource('ab/cd/pic.png');
		vi.spyOn(console, 'warn').mockImplementation(() => {});

		await expect(getOrCreateThumbnail('ab/cd/pic.png', 'image')).resolves.toBeNull();
		expect(state.sharpCalls).toBe(1);

		// Not remembered, so the very next request tries again.
		await expect(getOrCreateThumbnail('ab/cd/pic.png', 'image')).resolves.toBeNull();
		expect(state.sharpCalls).toBe(2);
		vi.restoreAllMocks();
	});

	it('forgets a failure once its TTL lapses', async () => {
		// The memo must not be permanent. Both encoders WRITE their output as part
		// of encoding, so a full or read-only DERIVED_DIR throws from inside the
		// decode step and is indistinguishable from a bad codec. Remembering that
		// forever strands a perfectly good source until someone restarts the
		// process — and on the image path the endpoint would go on serving
		// full-resolution originals under a year-long immutable cache.
		state.outcomes = ['timeout'];
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
