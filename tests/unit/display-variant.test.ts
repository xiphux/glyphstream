/** The chat thread's display-sized copy of an image. Real sharp, real files. */
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import sharp from 'sharp';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { photoPng } from './_helpers/photo-png';

const mocks = vi.hoisted(() => ({ dir: '' }));
vi.mock('#lib/server/env.js', () => ({
	mediaDir: () => mocks.dir,
	derivedDir: () => mocks.dir,
	dbPath: () => './data/glyphstream.db',
	configPath: () => './config.toml',
	logLevel: () => 'info',
}));

import {
	DISPLAY_MAX_DIM,
	displayStoragePath,
	getOrCreateDisplayVariant,
} from '#lib/server/media/display-variant.js';
import { DiskMediaStore } from '#lib/server/media/disk-store.js';
import { withGenerationSlot } from '#lib/server/media/thumbnail.js';

function write(storagePath: string, bytes: Buffer): void {
	const abs = resolve(mocks.dir, storagePath);
	mkdirSync(dirname(abs), { recursive: true });
	writeFileSync(abs, bytes);
}

beforeEach(() => {
	mocks.dir = mkdtempSync(join(tmpdir(), 'gs-display-'));
});
afterEach(() => {
	rmSync(mocks.dir, { recursive: true, force: true });
	vi.restoreAllMocks();
});

describe('getOrCreateDisplayVariant', () => {
	it('serves a smaller WebP no larger than the display size, and caches it', async () => {
		const original = await photoPng(3000, 2000);
		write('ab/cd/big.png', original);
		const v = await getOrCreateDisplayVariant('ab/cd/big.png');
		expect(v).not.toBeNull();
		expect(v!.contentType).toBe('image/webp');
		expect(v!.byteSize).toBeLessThan(original.byteLength);
		const meta = await sharp(v!.absolutePath).metadata();
		expect(meta.format).toBe('webp');
		expect(meta.width).toBe(DISPLAY_MAX_DIM);
		expect(meta.height).toBe(Math.round((DISPLAY_MAX_DIM * 2000) / 3000));
		expect(existsSync(resolve(mocks.dir, displayStoragePath('ab/cd/big.png')))).toBe(true);
	});

	it('keeps transparency', async () => {
		const rgba = await sharp({
			create: {
				width: 2400,
				height: 1600,
				channels: 4,
				background: { r: 0, g: 0, b: 0, alpha: 0 },
			},
		})
			.composite([{ input: await photoPng(1200, 800), top: 400, left: 600 }])
			.png()
			.toBuffer();
		write('ab/cd/cutout.png', rgba);
		const v = await getOrCreateDisplayVariant('ab/cd/cutout.png');
		expect(v).not.toBeNull();
		expect((await sharp(v!.absolutePath).metadata()).hasAlpha).toBe(true);
	});

	it('declines (serve the original) when the copy would not be smaller', async () => {
		// Small and already heavily compressed: re-encoding can only grow it.
		const noise = Buffer.alloc(96 * 96 * 3);
		for (let k = 0; k < noise.length; k++) noise[k] = (k * 2654435761) >>> 24;
		const jpeg = await sharp(noise, { raw: { width: 96, height: 96, channels: 3 } })
			.jpeg({ quality: 30 })
			.toBuffer();
		write('ab/cd/small.jpg', jpeg);
		expect(await getOrCreateDisplayVariant('ab/cd/small.jpg')).toBeNull();
	});

	it('remembers an image it cannot encode instead of decoding it on every view', async () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		write('ab/cd/broken.png', Buffer.from('not an image at all'));
		expect(await getOrCreateDisplayVariant('ab/cd/broken.png')).toBeNull();
		expect(await getOrCreateDisplayVariant('ab/cd/broken.png')).toBeNull();
		expect(warn).toHaveBeenCalledTimes(1);
	});

	it('reads the original only once it holds a generation slot', async () => {
		write('ab/cd/queued.png', await photoPng(3000, 2000));
		// Occupy every slot, so the request has to queue.
		let release!: () => void;
		const held = new Promise<void>((r) => (release = r));
		const holders = Array.from({ length: 16 }, () => withGenerationSlot(() => held));
		const pending = getOrCreateDisplayVariant('ab/cd/queued.png');
		await new Promise((r) => setTimeout(r, 50));
		// Gone while queued: a read taken ahead of the slot would still encode it.
		rmSync(resolve(mocks.dir, 'ab/cd/queued.png'));
		release();
		await Promise.all(holders);
		expect(await pending).toBeNull();
	});

	it('keeps every frame of an animated GIF', async () => {
		const frame = (r: number) =>
			sharp({ create: { width: 200, height: 200, channels: 3, background: { r, g: 40, b: 90 } } })
				.raw()
				.toBuffer();
		const frames = await Promise.all([0, 80, 160, 240].map(frame));
		const gif = await sharp(Buffer.concat(frames), {
			raw: { width: 200, height: 800, channels: 3, pageHeight: 200 },
		})
			.gif({ loop: 0, delay: [100, 100, 100, 100] })
			.toBuffer();
		expect((await sharp(gif).metadata()).pages).toBe(4);
		write('ab/cd/anim.gif', gif);
		const v = await getOrCreateDisplayVariant('ab/cd/anim.gif');
		expect(v).not.toBeNull();
		expect((await sharp(v!.absolutePath).metadata()).pages).toBe(4);
	});

	it('encodes once for concurrent requests', async () => {
		write('ab/cd/fan.png', await photoPng(2400, 1600));
		const toBuffer = vi.spyOn(sharp.prototype, 'toBuffer');
		const all = await Promise.all(
			Array.from({ length: 4 }, () => getOrCreateDisplayVariant('ab/cd/fan.png')),
		);
		expect(all.every((v) => v !== null)).toBe(true);
		expect(toBuffer).toHaveBeenCalledTimes(1);
	});

	it('is removed with the original', async () => {
		write('ab/cd/gone.png', await photoPng(2400, 1600));
		await getOrCreateDisplayVariant('ab/cd/gone.png');
		await new DiskMediaStore().delete('ab/cd/gone.png');
		expect(existsSync(resolve(mocks.dir, displayStoragePath('ab/cd/gone.png')))).toBe(false);
	});
});
