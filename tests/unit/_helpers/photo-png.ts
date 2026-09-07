import sharp from 'sharp';
import { Buffer } from 'node:buffer';

/**
 * A photo-like PNG: a smooth low-frequency base plus fine grain, which is the
 * shape of a real photo or screenshot. This matters — a synthetic *periodic*
 * pattern compresses to almost nothing as PNG and then gets BIGGER as JPEG, so a
 * naive fixture would exercise the decline-the-variant path and look like a bug
 * in the code rather than a bug in the fixture. Deterministic (fixed seed) so the
 * size assertions can't flake.
 */
export async function photoPng(width: number, height: number): Promise<Buffer> {
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
