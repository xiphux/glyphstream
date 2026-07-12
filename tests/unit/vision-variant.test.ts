/**
 * Tests for the downscaled variant inlined into vision requests.
 *
 * The invariant that matters: the ORIGINAL is never modified, and a variant is
 * only used when it's genuinely smaller. Everything else degrades to "inline the
 * original", which is what the code did before this existed.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { Buffer } from 'node:buffer';
import sharp from 'sharp';

const mocks = vi.hoisted(() => ({
	mediaDir: '',
	maxImageDim: 1568,
	imageQuality: 82,
}));
vi.mock('$lib/server/env', () => ({
	mediaDir: () => mocks.mediaDir,
	dbPath: () => './data/glyphstream.db',
	configPath: () => './config.toml',
	logLevel: () => 'info',
}));
vi.mock('$lib/server/endpoints/config', () => ({
	getVisionConfig: () => ({
		maxImageDim: mocks.maxImageDim,
		imageQuality: mocks.imageQuality,
	}),
}));

import {
	cachedVisionVariantSize,
	getVisionVariant,
	visionStoragePath,
} from '$lib/server/media/vision-variant';

/**
 * A photo-like PNG: a smooth low-frequency base plus fine grain, which is the
 * shape of a real photo or screenshot. This matters — a synthetic *periodic*
 * pattern compresses to almost nothing as PNG and then gets BIGGER as JPEG, so a
 * naive fixture would exercise the decline-the-variant path and look like a bug
 * in the code rather than a bug in the fixture. Deterministic (fixed seed) so the
 * size assertions can't flake.
 */
async function photoPng(width: number, height: number): Promise<Buffer> {
	let seed = 12345;
	const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
	const px = Buffer.alloc(width * height * 3);
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			const i = (y * width + x) * 3;
			const base = 128 + 100 * Math.sin(x / 180) * Math.cos(y / 140);
			const clamp = (n: number) => Math.max(0, Math.min(255, n));
			px[i] = clamp(base + rnd() * 24);
			px[i + 1] = clamp(base * 0.8 + rnd() * 24);
			px[i + 2] = clamp(base * 0.6 + rnd() * 24);
		}
	}
	return sharp(px, { raw: { width, height, channels: 3 } })
		.png()
		.toBuffer();
}

function write(storagePath: string, bytes: Buffer): void {
	const abs = resolve(mocks.mediaDir, storagePath);
	mkdirSync(dirname(abs), { recursive: true });
	writeFileSync(abs, bytes);
}

beforeEach(() => {
	mocks.mediaDir = mkdtempSync(join(tmpdir(), 'gs-vision-test-'));
	mocks.maxImageDim = 1568;
	mocks.imageQuality = 82;
});

afterEach(() => {
	rmSync(mocks.mediaDir, { recursive: true, force: true });
	vi.restoreAllMocks();
});

describe('getVisionVariant', () => {
	it('downscales an oversized image and leaves the original untouched', async () => {
		const original = await photoPng(3000, 2000);
		write('ab/cd/big.png', original);

		const variant = await getVisionVariant('ab/cd/big.png');
		expect(variant).not.toBeNull();
		expect(variant!.contentType).toBe('image/jpeg');
		expect(variant!.bytes.byteLength).toBeLessThan(original.byteLength);

		// Long edge clamped to the configured cap, aspect ratio preserved.
		const meta = await sharp(variant!.bytes).metadata();
		expect(meta.width).toBe(1568);
		expect(meta.height).toBe(1045);

		// The original file on disk is byte-for-byte what we wrote. This is the
		// whole safety property: the gallery, downloads, and image-to-image all
		// still see full resolution.
		const onDisk = readFileSync(resolve(mocks.mediaDir, 'ab/cd/big.png'));
		expect(onDisk.equals(original)).toBe(true);
	});

	it('caches the variant as a sibling file and reuses it', async () => {
		write('ab/cd/big.png', await photoPng(2400, 1600));

		const first = await getVisionVariant('ab/cd/big.png');
		const cachedPath = resolve(mocks.mediaDir, visionStoragePath('ab/cd/big.png'));
		expect(existsSync(cachedPath)).toBe(true);

		// Second call must not re-encode — it reads the cached bytes verbatim.
		const second = await getVisionVariant('ab/cd/big.png');
		expect(second!.bytes.equals(first!.bytes)).toBe(true);
	});

	it('re-encodes an under-cap image whose PNG encoding is wasteful', async () => {
		// 1200x800 is within the dimension cap, but a noisy PNG at that size is
		// still megabytes. Resolution isn't the only way an image is too big, so
		// the variant must be judged on bytes, not just on dimensions.
		const original = await photoPng(1200, 800);
		write('ab/cd/wasteful.png', original);

		const variant = await getVisionVariant('ab/cd/wasteful.png');
		expect(variant).not.toBeNull();
		expect(variant!.bytes.byteLength).toBeLessThan(original.byteLength);
		// Dimensions preserved — it was never oversized, only over-encoded.
		const meta = await sharp(variant!.bytes).metadata();
		expect(meta.width).toBe(1200);
		expect(meta.height).toBe(800);
	});

	it('declines when the re-encode would not be smaller', async () => {
		// A tiny, already-efficient JPEG. Round-tripping it through sharp comes out
		// no smaller, and inlining it would lose quality for nothing.
		const tiny = await sharp({
			create: { width: 8, height: 8, channels: 3, background: '#336699' },
		})
			.jpeg({ quality: 82 })
			.toBuffer();
		write('ab/cd/tiny.jpg', tiny);

		expect(await getVisionVariant('ab/cd/tiny.jpg')).toBeNull();
		// And it must not have cached a variant it decided against using.
		expect(existsSync(resolve(mocks.mediaDir, visionStoragePath('ab/cd/tiny.jpg')))).toBe(false);
	});

	it('flattens transparency onto white rather than black', async () => {
		// JPEG has no alpha. sharp's default composite is onto BLACK, which turns a
		// transparent-background diagram into an unreadable smear — the exact bug
		// this guards.
		const transparent = await sharp({
			create: {
				width: 2000,
				height: 2000,
				channels: 4,
				background: { r: 255, g: 255, b: 255, alpha: 0 },
			},
		})
			.png()
			.toBuffer();
		write('ab/cd/alpha.png', transparent);

		const variant = await getVisionVariant('ab/cd/alpha.png');
		const { data } = await sharp(variant!.bytes).raw().toBuffer({ resolveWithObject: true });
		// Sample the centre pixel: white, not black.
		expect(data[0]).toBeGreaterThan(240);
	});

	it('returns null (inline the original) when downscaling is disabled', async () => {
		mocks.maxImageDim = 0;
		write('ab/cd/big.png', await photoPng(3000, 2000));
		expect(await getVisionVariant('ab/cd/big.png')).toBeNull();
	});

	it('returns null for a file sharp cannot decode, rather than throwing', async () => {
		// A send must not die because one attachment is corrupt — the caller falls
		// back to the original bytes.
		vi.spyOn(console, 'warn').mockImplementation(() => {});
		write('ab/cd/corrupt.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]));
		expect(await getVisionVariant('ab/cd/corrupt.png')).toBeNull();
	});

	it('returns null for a source that is not on disk', async () => {
		expect(await getVisionVariant('no/su/ch.png')).toBeNull();
	});
});

describe('cachedVisionVariantSize', () => {
	it('is null before the image has ever been inlined, and the size after', async () => {
		write('ab/cd/big.png', await photoPng(2400, 1600));

		// Stat-only: it must NOT generate the variant as a side effect, or opening
		// the context panel would re-encode a whole thread's images.
		expect(await cachedVisionVariantSize('ab/cd/big.png')).toBeNull();

		const variant = await getVisionVariant('ab/cd/big.png');
		expect(await cachedVisionVariantSize('ab/cd/big.png')).toBe(variant!.bytes.byteLength);
	});
});
