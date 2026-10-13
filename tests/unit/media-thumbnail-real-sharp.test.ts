/**
 * Gallery thumbnails through the REAL sharp, for every image format the media
 * store accepts.
 *
 * media-thumbnail-concurrency.test.ts mocks sharp, and media-derived-dir.test.ts
 * only checks that a file appeared, so nothing looked at what sharp produced.
 * sharp minors auto-merge and each one moves the bundled libvips; a dropped
 * decoder (avif and gif come from optional libvips modules), a changed `resize`
 * default, or `mozjpeg` quietly no-oping would pass. The failure isn't loud
 * either: a tile that fails to decode falls back to streaming the full original,
 * which is exactly the slow gallery thumbnails exist to prevent.
 */
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import sharp, { type Sharp } from 'sharp';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { photoPng } from './_helpers/photo-png';
import { bilevelPng } from './_helpers/bilevel-png';

const state = vi.hoisted(() => ({ root: '' }));

vi.mock('#lib/server/env.js', () => ({
	mediaDir: () => state.root,
	derivedDir: () => state.root,
}));

import { getOrCreateThumbnail } from '#lib/server/media/thumbnail.js';

function writeOriginal(storagePath: string, bytes: Buffer) {
	const abs = resolve(state.root, storagePath);
	mkdirSync(dirname(abs), { recursive: true });
	writeFileSync(abs, bytes);
}

beforeEach(() => {
	state.root = mkdtempSync(join(tmpdir(), 'gs-thumb-sharp-'));
});

afterEach(() => {
	rmSync(state.root, { recursive: true, force: true });
});

// Every type in disk-store.ts's MIME → extension map.
const FORMATS = {
	png: (s: Sharp) => s.png(),
	jpg: (s: Sharp) => s.jpeg(),
	webp: (s: Sharp) => s.webp(),
	gif: (s: Sharp) => s.gif(),
	avif: (s: Sharp) => s.avif({ effort: 0 }),
} as const;

describe('getOrCreateThumbnail with real sharp', () => {
	it.each(Object.keys(FORMATS) as Array<keyof typeof FORMATS>)(
		'decodes a %s original into a ≤512px JPEG, aspect preserved',
		async (ext) => {
			const original = await FORMATS[ext](sharp(await photoPng(1200, 800))).toBuffer();
			const storagePath = `ab/cd/photo.${ext}`;
			writeOriginal(storagePath, original);

			const thumb = await getOrCreateThumbnail(storagePath, 'image');
			expect(thumb).not.toBeNull();
			const bytes = await readFile(thumb!.absolutePath);
			expect(thumb!.byteSize).toBe(bytes.length);

			const meta = await sharp(bytes).metadata();
			expect(meta).toMatchObject({ format: 'jpeg', width: 512, height: 341 });
			// A 512px photo-like JPEG at q75 is tens of KB. A thumb anywhere near the
			// original's size means the encode settings stopped applying.
			expect(bytes.length).toBeLessThan(80_000);
		},
	);

	it('never enlarges an image already under the cap', async () => {
		writeOriginal('ab/cd/small.png', await photoPng(200, 120));
		const thumb = await getOrCreateThumbnail('ab/cd/small.png', 'image');
		const meta = await sharp(await readFile(thumb!.absolutePath)).metadata();
		expect(meta).toMatchObject({ format: 'jpeg', width: 200, height: 120 });
	});

	it('applies EXIF orientation, so a phone photo is not sideways', async () => {
		// Phones store the sensor's landscape pixels and record how to turn them
		// in EXIF. Stored 800×400 with orientation 6 (rotate 90° clockwise), this
		// photo is displayed 400×800 — and its thumbnail must be portrait too.
		const tagged = await sharp(await photoPng(800, 400))
			.jpeg()
			.withMetadata({ orientation: 6 })
			.toBuffer();
		writeOriginal('ab/cd/phone.jpg', tagged);
		const thumb = await getOrCreateThumbnail('ab/cd/phone.jpg', 'image');
		const meta = await sharp(await readFile(thumb!.absolutePath)).metadata();
		expect(meta).toMatchObject({ width: 256, height: 512 });
	});

	it('fits a tall image by its height', async () => {
		writeOriginal('ab/cd/tall.png', await photoPng(400, 1600));
		const thumb = await getOrCreateThumbnail('ab/cd/tall.png', 'image');
		const meta = await sharp(await readFile(thumb!.absolutePath)).metadata();
		expect(meta).toMatchObject({ width: 128, height: 512 });
	});

	it('refuses to decode an image past the pixel limit', async () => {
		// 144 MP: over MAX_DECODE_PIXELS, under sharp's own 268 MP default, so
		// only the limit stops this decode.
		vi.spyOn(console, 'warn').mockImplementation(() => {});
		writeOriginal('ab/cd/huge.png', bilevelPng(12_000, 12_000));
		await expect(getOrCreateThumbnail('ab/cd/huge.png', 'image')).resolves.toBeNull();
		vi.restoreAllMocks();
	});

	it('still thumbnails a large but plausible image (a 60 MP panorama)', async () => {
		writeOriginal('ab/cd/pano.png', bilevelPng(15_000, 4_000));
		const thumb = await getOrCreateThumbnail('ab/cd/pano.png', 'image');
		expect(thumb).not.toBeNull();
	});

	it('returns null for bytes sharp cannot decode, leaving no partial thumb', async () => {
		vi.spyOn(console, 'warn').mockImplementation(() => {});
		writeOriginal('ab/cd/corrupt.png', Buffer.from('\x89PNG\r\n\x1a\nnot really a png'));
		await expect(getOrCreateThumbnail('ab/cd/corrupt.png', 'image')).resolves.toBeNull();
		expect(readdirSync(resolve(state.root, 'ab/cd'))).toEqual(['corrupt.png']);
		vi.restoreAllMocks();
	});
});
