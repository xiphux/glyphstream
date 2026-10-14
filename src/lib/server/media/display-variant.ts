/**
 * A display-sized copy of an image for the chat thread.
 *
 * A chat bubble is at most ~768 CSS px wide, but it loaded the original: a
 * generated PNG of 1–2 MB, per image, every time a long thread opened. This
 * serves a WebP at most DISPLAY_MAX_DIM on the long side instead, crisp on a
 * high-density screen at bubble width and typically a tenth of the bytes.
 * WebP rather than the thumbnails' JPEG because it keeps transparency: a
 * background-removal result must not turn up on a black or white box. The
 * lightbox, downloads and image-to-image still use the original.
 *
 * Same shape as vision-variant.ts: generated on first request, cached as a
 * sibling under `derivedDir()`, deleted with the original by `disk-store`,
 * deduplicated per image, decoded inside the shared generation slots and under
 * the pixel limit. Null means "serve the original": a variant that wouldn't be
 * smaller (a small or already-compressed image), an undecodable file, or an
 * unreadable volume. Callers must never treat null as an error.
 */
import sharp from 'sharp';
import { mkdirSync } from 'node:fs';
import { readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { derivedDir, mediaDir } from '../env';
import { MAX_DECODE_PIXELS } from './decode-limits';
import { withGenerationSlot } from './thumbnail';

/** Long-side ceiling, in pixels. */
export const DISPLAY_MAX_DIM = 1280;
const DISPLAY_QUALITY = 82;

/** The original's relative path plus `.display.webp`, under `derivedDir()`. */
export function displayStoragePath(storagePath: string): string {
	return `${storagePath}.display.webp`;
}

export interface DisplayVariantRef {
	absolutePath: string;
	byteSize: number;
	contentType: 'image/webp';
}

/** Images whose variant came out no smaller than the original. In memory, so a
 *  declined image costs one wasted encode per process rather than one per view;
 *  bounded so a large library can't grow it without limit. */
const declined = new Set<string>();
const DECLINED_MAX = 4096;

const generating = new Map<string, Promise<DisplayVariantRef | null>>();

export async function getOrCreateDisplayVariant(
	storagePath: string,
): Promise<DisplayVariantRef | null> {
	if (declined.has(storagePath)) return null;
	const variantAbs = resolve(derivedDir(), displayStoragePath(storagePath));
	try {
		const st = await stat(variantAbs);
		return { absolutePath: variantAbs, byteSize: st.size, contentType: 'image/webp' };
	} catch {
		// Not cached yet (or unreadable): generate below.
	}
	const pending = generating.get(variantAbs);
	if (pending) return pending;
	const job = generate(storagePath, variantAbs);
	generating.set(variantAbs, job);
	try {
		return await job;
	} finally {
		generating.delete(variantAbs);
	}
}

async function generate(
	storagePath: string,
	variantAbs: string,
): Promise<DisplayVariantRef | null> {
	let original: Buffer;
	try {
		original = await readFile(resolve(mediaDir(), storagePath));
	} catch (e) {
		if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
			console.warn(`[display-variant] original for ${storagePath} unreadable:`, e);
		}
		return null;
	}
	const tmp = `${variantAbs}.${randomUUID()}.tmp`;
	try {
		const encoded = await withGenerationSlot(() =>
			// `animated`: every frame, not just the first. Without it an animated GIF
			// or WebP came out as one still frame, which is always smaller, so the
			// size check below served it and the thread stopped animating.
			sharp(original, { limitInputPixels: MAX_DECODE_PIXELS, animated: true })
				// EXIF orientation first; the re-encode drops metadata.
				.rotate()
				.resize(DISPLAY_MAX_DIM, DISPLAY_MAX_DIM, { fit: 'inside', withoutEnlargement: true })
				.webp({ quality: DISPLAY_QUALITY })
				.toBuffer(),
		);
		if (encoded.byteLength >= original.byteLength) {
			if (declined.size >= DECLINED_MAX) declined.clear();
			declined.add(storagePath);
			return null;
		}
		mkdirSync(dirname(variantAbs), { recursive: true });
		// Atomic: a torn write must never be served (immutable for a year).
		await writeFile(tmp, encoded);
		await rename(tmp, variantAbs);
		return { absolutePath: variantAbs, byteSize: encoded.byteLength, contentType: 'image/webp' };
	} catch (e) {
		await unlink(tmp).catch(() => {});
		console.warn(`[display-variant] generation failed for ${storagePath}:`, e);
		return null;
	}
}
