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
import { createLogger } from '../log';

const log = createLogger('dimensions');

export interface ImageDimensions {
	width: number;
	height: number;
}

export const UNKNOWN_DIMENSIONS: ImageDimensions = { width: 0, height: 0 };

/** The upright size of an image, from its bytes or a file path. Never throws. */
export async function probeImageDimensions(input: Buffer | string): Promise<ImageDimensions> {
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

/** A row's stored pair as something a client can use: null when it was never
 *  probed (NULL) or probed and unknown (0). */
export function storedDimensions(
	width: number | null,
	height: number | null,
): ImageDimensions | null {
	return width && height ? { width, height } : null;
}
