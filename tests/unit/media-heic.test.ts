/**
 * HEIC uploads: recognising one, and the declared-size check that runs before
 * ffmpeg does. ffmpeg itself is mocked here, as in the video thumbnail tests;
 * that the image's ffmpeg really decodes a tiled, rotated HEIC is proven by the
 * Dockerfile's build probe and the image smoke run, against the same sample.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
	runFfmpeg: vi.fn(async (_args: string[], _budgetMs: number, _out: string) => {}),
	/** What the stand-in ffmpeg writes: the sample, stitched and turned upright. */
	output: { width: 768, height: 1024 },
}));
vi.mock('#lib/server/media/ffmpeg.js', () => ({ runFfmpeg: mocks.runFfmpeg }));

import {
	convertHeicToJpeg,
	HeicConversionError,
	isHeicUpload,
	readDeclaredImage,
} from '#lib/server/media/heic.js';
import { MAX_DECODE_PIXELS } from '#lib/server/media/decode-limits.js';
import sharp from 'sharp';

/** A stand-in ffmpeg that writes a JPEG of `mocks.output`'s size. */
async function writeOutput(_args: string[], _budgetMs: number, out: string) {
	const { width, height } = mocks.output;
	await sharp({ create: { width, height, channels: 3, background: '#888' } })
		.jpeg()
		.toFile(out);
}

const SAMPLE = readFileSync(new URL('../image-smoke/tiled-rotated.heic', import.meta.url));

/** A minimal HEIF header: ftyp, then a meta box holding one ispe. */
function heifWithIspe(width: number, height: number): Uint8Array {
	const box = (type: string, body: Uint8Array) => {
		const out = new Uint8Array(8 + body.length);
		new DataView(out.buffer).setUint32(0, out.length);
		out.set(new TextEncoder().encode(type), 4);
		out.set(body, 8);
		return out;
	};
	const ispe = new Uint8Array(12);
	new DataView(ispe.buffer).setUint32(4, width);
	new DataView(ispe.buffer).setUint32(8, height);
	const ftyp = box('ftyp', new TextEncoder().encode('heic\0\0\0\0mif1heic'));
	const meta = box('meta', new Uint8Array([0, 0, 0, 0, ...box('ispe', ispe)]));
	return new Uint8Array([...ftyp, ...meta]);
}

describe('isHeicUpload', () => {
	it.each([
		['image/heic', 'IMG_1.HEIC'],
		['image/heif', 'photo'],
		['image/heic-sequence', 'burst.heics'],
		['', 'IMG_2.heic'],
		['application/octet-stream', 'IMG_3.HEIF'],
	])('recognises %s named %s', (type, name) => {
		expect(isHeicUpload(type, name)).toBe(true);
	});

	it.each([
		['image/jpeg', 'IMG_4.heic'], // typed as something else: trust the type
		['', 'notes.txt'],
		['image/avif', 'x.avif'],
	])('leaves %s named %s alone', (type, name) => {
		expect(isHeicUpload(type, name)).toBe(false);
	});
});

describe('readDeclaredImage', () => {
	it('reads the grid size and rotation of an iPhone-style tiled, rotated HEIC', () => {
		// Stored landscape, flagged 270° anticlockwise: it displays portrait.
		expect(readDeclaredImage(SAMPLE)).toEqual({ width: 1024, height: 768, quarterTurns: 3 });
	});

	it('reads a declared size, unrotated', () => {
		expect(readDeclaredImage(heifWithIspe(8064, 6048))).toEqual({
			width: 8064,
			height: 6048,
			quarterTurns: 0,
		});
	});

	it('finds nothing in a file that is not HEIF', () => {
		expect(readDeclaredImage(new TextEncoder().encode('just some text, not a photo'))).toBe(null);
	});
});

describe('convertHeicToJpeg', () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), 'gs-heic-test-'));
		mocks.runFfmpeg.mockReset().mockImplementation(writeOutput);
		mocks.output = { width: 768, height: 1024 };
	});
	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	it('decodes a HEIC within the size ceiling', async () => {
		writeFileSync(join(dir, 'in.heic'), SAMPLE);
		await convertHeicToJpeg(join(dir, 'in.heic'), join(dir, 'out.jpg'));
		expect(mocks.runFfmpeg).toHaveBeenCalledOnce();
		const args = mocks.runFfmpeg.mock.calls[0][0];
		expect(args).toEqual(expect.arrayContaining(['-protocol_whitelist', 'file']));
	});

	it('refuses a file declaring more pixels than the decode ceiling, without running ffmpeg', async () => {
		// A few bytes of header can claim a grid of billions of pixels.
		writeFileSync(join(dir, 'in.heic'), heifWithIspe(65_535, 65_535));
		await expect(convertHeicToJpeg(join(dir, 'in.heic'), join(dir, 'out.jpg'))).rejects.toThrow(
			HeicConversionError,
		);
		expect(mocks.runFfmpeg).not.toHaveBeenCalled();
		expect(65_535 * 65_535).toBeGreaterThan(MAX_DECODE_PIXELS);
	});

	it('refuses something that is not a HEIC, without running ffmpeg', async () => {
		writeFileSync(join(dir, 'in.heic'), 'not a photo');
		await expect(convertHeicToJpeg(join(dir, 'in.heic'), join(dir, 'out.jpg'))).rejects.toThrow(
			HeicConversionError,
		);
		expect(mocks.runFfmpeg).not.toHaveBeenCalled();
	});

	it('converts one photo at a time', async () => {
		let running = 0;
		let peak = 0;
		mocks.runFfmpeg.mockImplementation(async (args, budget, out) => {
			running++;
			peak = Math.max(peak, running);
			await new Promise((r) => setTimeout(r, 10));
			await writeOutput(args, budget, out);
			running--;
		});
		for (const n of [1, 2, 3]) writeFileSync(join(dir, `in${n}.heic`), SAMPLE);
		await Promise.all(
			[1, 2, 3].map((n) => convertHeicToJpeg(join(dir, `in${n}.heic`), join(dir, `out${n}.jpg`))),
		);
		expect(mocks.runFfmpeg).toHaveBeenCalledTimes(3);
		expect(peak).toBe(1);
	});

	it('keeps converting after one fails', async () => {
		mocks.runFfmpeg.mockRejectedValueOnce(new Error('boom'));
		writeFileSync(join(dir, 'in.heic'), SAMPLE);
		await expect(convertHeicToJpeg(join(dir, 'in.heic'), join(dir, 'a.jpg'))).rejects.toThrow();
		await expect(
			convertHeicToJpeg(join(dir, 'in.heic'), join(dir, 'b.jpg')),
		).resolves.toBeUndefined();
	});

	it.each([
		['a single tile', { width: 512, height: 512 }],
		['the photo on its side', { width: 1024, height: 768 }],
		['the embedded thumbnail', { width: 240, height: 320 }],
	])('refuses an ffmpeg result that is %s, not the whole photo upright', async (_name, size) => {
		// What an ffmpeg too old to stitch tiles or apply the rotation can write
		// while still exiting 0.
		mocks.output = size;
		writeFileSync(join(dir, 'in.heic'), SAMPLE);
		await expect(convertHeicToJpeg(join(dir, 'in.heic'), join(dir, 'out.jpg'))).rejects.toThrow(
			HeicConversionError,
		);
	});

	it('accepts a result a few pixels short of the declared size (a clean-aperture crop)', async () => {
		mocks.output = { width: 760, height: 1016 };
		writeFileSync(join(dir, 'in.heic'), SAMPLE);
		await expect(
			convertHeicToJpeg(join(dir, 'in.heic'), join(dir, 'out.jpg')),
		).resolves.toBeUndefined();
	});

	it("reports ffmpeg's failure as a conversion error", async () => {
		mocks.runFfmpeg.mockRejectedValueOnce(new Error('Invalid data found when processing input'));
		writeFileSync(join(dir, 'in.heic'), SAMPLE);
		await expect(convertHeicToJpeg(join(dir, 'in.heic'), join(dir, 'out.jpg'))).rejects.toThrow(
			HeicConversionError,
		);
	});
});
