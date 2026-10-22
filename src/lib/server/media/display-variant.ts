/**
 * A display-sized copy of an image for the chat thread.
 *
 * A chat bubble is at most ~768 CSS px wide, but it loaded the original: a
 * generated PNG of 1–2 MB, per image, every time a long thread opened. This
 * serves a WebP at most DISPLAY_MAX_DIM on the long side instead, crisp on a
 * high-density screen at bubble width and typically a tenth of the bytes.
 * WebP rather than the vision variant's JPEG because it keeps transparency: a
 * background-removal result must not turn up on a black or white box.
 *
 * The lightbox asks for the larger sizes too, through a `srcset` over the
 * ladder in `#lib/media-variants.ts`; each size is its own file and its own
 * cache entry. Downloads and image-to-image still use the original.
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
import { discardIfOriginalGone } from './derived-orphan';
import { withGenerationSlot } from './thumbnail';
import { createLogger } from '../log';
import { DISPLAY_SIZES, type DisplaySize } from '#lib/media-variants.js';

const log = createLogger('display-variant');

/** The default size's long side, in pixels — the chat bubble's copy. The
 *  lightbox's `srcset` also asks for the larger ones in `DISPLAY_SIZES`. */
export const DISPLAY_MAX_DIM = DISPLAY_SIZES[0];
const DISPLAY_QUALITY = 82;

/** The original's relative path plus `.display.webp` (the default size, named
 *  as it always was) or `.display-<size>.webp`, under `derivedDir()`. */
export function displayStoragePath(
	storagePath: string,
	size: DisplaySize = DISPLAY_MAX_DIM,
): string {
	return size === DISPLAY_MAX_DIM
		? `${storagePath}.display.webp`
		: `${storagePath}.display-${size}.webp`;
}

/** Every size's path, for deleting them with the original. */
export function displayStoragePaths(storagePath: string): string[] {
	return DISPLAY_SIZES.map((size) => displayStoragePath(storagePath, size));
}

export interface DisplayVariantRef {
	absolutePath: string;
	byteSize: number;
	contentType: 'image/webp';
}

/** Images whose variant came out no smaller than the original, or couldn't be
 *  encoded at all. In memory, so a declined image costs one wasted encode per
 *  process rather than one per view; bounded so a large library can't grow it
 *  without limit. A failed WRITE isn't remembered: that's the volume, not the
 *  image, and it may be fixed without a restart. */
const declined = new Set<string>();
const DECLINED_MAX = 4096;

/** Keyed by the variant's path, so each size is remembered on its own. */
function decline(variantPath: string): void {
	if (declined.size >= DECLINED_MAX) declined.clear();
	declined.add(variantPath);
}

const generating = new Map<string, Promise<DisplayVariantRef | null>>();

export async function getOrCreateDisplayVariant(
	storagePath: string,
	size: DisplaySize = DISPLAY_MAX_DIM,
): Promise<DisplayVariantRef | null> {
	const variantPath = displayStoragePath(storagePath, size);
	if (declined.has(variantPath)) return null;
	const variantAbs = resolve(derivedDir(), variantPath);
	try {
		const st = await stat(variantAbs);
		return { absolutePath: variantAbs, byteSize: st.size, contentType: 'image/webp' };
	} catch {
		// Not cached yet (or unreadable): generate below.
	}
	const pending = generating.get(variantAbs);
	if (pending) return pending;
	const job = generate(storagePath, variantPath, variantAbs, size);
	generating.set(variantAbs, job);
	try {
		return await job;
	} finally {
		generating.delete(variantAbs);
	}
}

async function generate(
	storagePath: string,
	variantPath: string,
	variantAbs: string,
	size: DisplaySize,
): Promise<DisplayVariantRef | null> {
	let job: { encoded: Buffer; originalBytes: number } | null;
	try {
		// The original is read INSIDE the slot: read ahead of it, every queued
		// image (a long thread opened for the first time) held its whole file in
		// memory while it waited.
		job = await withGenerationSlot(async () => {
			let original: Buffer;
			try {
				original = await readFile(resolve(mediaDir(), storagePath));
			} catch (e) {
				if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
					log.warn(`original for ${storagePath} unreadable:`, e);
				}
				return null;
			}
			// `animated`: every frame, not just the first. Without it an animated GIF
			// or WebP came out as one still frame, which is always smaller, so the
			// size check below served it and the thread stopped animating.
			const encoded = await sharp(original, { limitInputPixels: MAX_DECODE_PIXELS, animated: true })
				// EXIF orientation first; the re-encode drops metadata.
				.rotate()
				.resize(size, size, { fit: 'inside', withoutEnlargement: true })
				.webp({ quality: DISPLAY_QUALITY })
				.toBuffer();
			return { encoded, originalBytes: original.byteLength };
		});
	} catch (e) {
		// An image sharp can't make a copy of (undecodable, or an animated one
		// with a 90° EXIF rotation) fails the same way every time: remember it,
		// or every view re-reads and re-decodes the whole original.
		decline(variantPath);
		log.warn(`could not encode ${storagePath}:`, e);
		return null;
	}
	if (job === null) return null;
	const { encoded, originalBytes } = job;
	if (encoded.byteLength >= originalBytes) {
		decline(variantPath);
		return null;
	}
	const tmp = `${variantAbs}.${randomUUID()}.tmp`;
	try {
		mkdirSync(dirname(variantAbs), { recursive: true });
		// Atomic: a torn write must never be served (immutable for a year).
		await writeFile(tmp, encoded);
		await rename(tmp, variantAbs);
		// See derived-orphan.ts: a delete mid-encode would otherwise strand it.
		if (await discardIfOriginalGone(resolve(mediaDir(), storagePath), variantAbs)) return null;
		return { absolutePath: variantAbs, byteSize: encoded.byteLength, contentType: 'image/webp' };
	} catch (e) {
		await unlink(tmp).catch(() => {});
		log.warn(`could not save the copy of ${storagePath}:`, e);
		return null;
	}
}
