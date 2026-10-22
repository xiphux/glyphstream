/**
 * An image's intrinsic size, as stored on `media.width` / `media.height`.
 *
 * Read from the header (sharp's `metadata()` decodes no pixels), upright: the
 * EXIF-oriented size, because that's the shape every surface draws — the
 * display and thumbnail variants `.rotate()` first, and browsers honour EXIF
 * orientation on the original. An animated image reports one frame.
 *
 * `UNKNOWN_DIMENSIONS` (0 × 0) is the answer for a file that has been looked at
 * and has no readable size — undecodable, or gone from disk. It is stored rather
 * than left NULL so the backfill (`dimensions-backfill.ts`) can tell "never
 * probed" from "probed, nothing to find" and doesn't re-read the same broken
 * file on every sweep. Readers map it to "no dimensions" (`storedDimensions`).
 */
import sharp from 'sharp';
import { readFile, stat } from 'node:fs/promises';
import { createLogger } from '../log';

const log = createLogger('dimensions');

export interface ImageDimensions {
	width: number;
	height: number;
}

export const UNKNOWN_DIMENSIONS: ImageDimensions = { width: 0, height: 0 };

/** The upright size of an image from its bytes; 0 × 0 when they don't decode.
 *  Never throws. A stored file goes through `probeStoredImage`. */
export function probeImageDimensions(input: Buffer): Promise<ImageDimensions> {
	return probe(input);
}

async function probe(input: Buffer | string): Promise<ImageDimensions> {
	try {
		const { autoOrient } = await sharp(input).metadata();
		if (autoOrient.width > 0 && autoOrient.height > 0) {
			return { width: autoOrient.width, height: autoOrient.height };
		}
	} catch (e) {
		log.warn(`could not read dimensions of ${typeof input === 'string' ? input : 'an image'}:`, e);
	}
	return UNKNOWN_DIMENSIONS;
}

/**
 * What probing a STORED original found. Unlike `probeImageDimensions`, which
 * runs on bytes just written, this one tells "the file is bad" from "the file
 * can't be reached right now", so a caller recording the 0 × 0 marker — which
 * is permanent — only does so for the first:
 *
 * - `dims`: its size, or 0 × 0 when it is there and doesn't decode.
 * - `missing`: no file at the path. Permanent only if the volume is really
 *   there (an unmounted mountpoint is an empty directory, so every file in it
 *   reads as missing); the caller decides.
 * - `unavailable`: any other filesystem error (EIO, EACCES, EMFILE…). Try again
 *   later.
 *
 * It reads the whole file rather than letting sharp open the path, so every
 * filesystem error surfaces here and only a decode failure becomes 0 × 0: sharp
 * reports a failed read and a corrupt file the same way.
 */
export type StoredProbe = { dims: ImageDimensions } | { missing: true } | { unavailable: unknown };

export async function probeStoredImage(absPath: string): Promise<StoredProbe> {
	let bytes: Buffer;
	try {
		bytes = await readFile(absPath);
	} catch (e) {
		const code = (e as NodeJS.ErrnoException).code;
		return code === 'ENOENT' || code === 'ENOTDIR' ? { missing: true } : { unavailable: e };
	}
	return { dims: await probeImageDimensions(bytes) };
}

/**
 * The size of a file this process has just written (an upload, streamed to
 * disk), or null when it can't be reached — leave it NULL for the backfill.
 * Unlike `probeStoredImage` it lets sharp read the path, which reads only the
 * header instead of the whole file: a read that fails partway through is then
 * taken as undecodable, which for a file written a moment ago is the
 * overwhelmingly likely meaning anyway.
 */
export async function probeWrittenImage(absPath: string): Promise<ImageDimensions | null> {
	try {
		await stat(absPath);
	} catch (e) {
		log.warn(`could not reach ${absPath} to read its dimensions:`, e);
		return null;
	}
	return probe(absPath);
}

/** A row's stored pair as something a client can use: null when it was never
 *  probed (NULL) or probed and unknown (0). */
export function storedDimensions(
	width: number | null,
	height: number | null,
): ImageDimensions | null {
	return width && height ? { width, height } : null;
}
