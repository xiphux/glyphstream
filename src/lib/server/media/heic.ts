/**
 * HEIC/HEIF photos, converted to JPEG at upload.
 *
 * An iPhone saves photos as HEIC, and nothing downstream can read one: sharp's
 * prebuilt libvips leaves out the HEVC decoder (it reads AVIF only), Chrome and
 * Firefox can't display it, and vision models want JPEG or PNG. Stored as-is it
 * was a broken thumbnail, a broken lightbox and a raw HEIC inlined to the model.
 * Converted once at upload, every one of those just sees a JPEG.
 *
 * ffmpeg does the decode: the image already carries it for video, with the
 * HEVC decoder and the `mov` demuxer HEIF needs. An iPhone HEIC is a grid of
 * 512 px HEVC tiles that ffmpeg stitches back with `xstack` and `crop` (the
 * Dockerfile names `xstack`; ffmpeg's CLI pulls `crop` in itself), and a
 * portrait photo is stored landscape with a rotation flag that it applies
 * by inserting `transpose`. The Dockerfile's build probe decodes a tiled,
 * rotated sample with these exact arguments.
 */
import { open } from 'node:fs/promises';
import { MAX_DECODE_PIXELS } from './decode-limits';
import { runFfmpeg } from './ffmpeg';

const HEIC_TYPES = new Set([
	'image/heic',
	'image/heif',
	'image/heic-sequence',
	'image/heif-sequence',
]);

/**
 * Whether an upload is a HEIC/HEIF photo. By type, or — since a browser
 * whose OS has no mapping for `.heic` sends it untyped — by name when the type
 * says nothing.
 */
export function isHeicUpload(contentType: string, filename: string): boolean {
	if (HEIC_TYPES.has(contentType)) return true;
	const untyped = contentType === '' || contentType === 'application/octet-stream';
	return untyped && /\.hei[cf]$/i.test(filename);
}

/** A 48 MP iPhone photo decodes in a few seconds on one thread; this is the
 *  ceiling for something that is no longer a photo. */
const HEIC_TIMEOUT_MS = 30_000;

/** Highest quality ffmpeg's mjpeg encoder offers (2-31, lower is better). The
 *  JPEG is the only copy kept, so it is the original from here on; a 12 MP
 *  photo comes out around 1.7 MB. */
const HEIC_JPEG_QSCALE = '2';

/** Only the start of the file is read for the size check: the boxes that
 *  declare dimensions come before the image data in every HEIF writer. */
const HEADER_BYTES = 256 * 1024;

/**
 * One conversion at a time, in a slot of its own rather than one of the three
 * generation slots thumbnails and the display/vision copies share.
 *
 * Memory: the declared-size check bounds what the file claims, not the canvas
 * ffmpeg stitches — that is sized from the grid's tiles, which a crafted file
 * can make large while declaring a small image, up to libavutil's own ceiling
 * of about 268 MP (~400 MB of frame, plus the copies the rotation and encode
 * make). Bounding it exactly means resolving HEIF item associations; running
 * one at a time caps the worst case at one such job instead of three.
 *
 * Isolation: picking a batch of iPhone photos uploads them all at once, each a
 * conversion of a few seconds. In the shared slots that queued every thumbnail,
 * chat image and vision send in the process behind the batch.
 */
let lastConversion: Promise<unknown> = Promise.resolve();
function oneAtATime<T>(fn: () => Promise<T>): Promise<T> {
	const run = lastConversion.then(fn, fn);
	lastConversion = run.catch(() => {});
	return run;
}

export class HeicConversionError extends Error {
	constructor(message: string, options?: { cause?: unknown }) {
		super(message, options);
		this.name = 'HeicConversionError';
	}
}

/**
 * The largest image size any `ispe` (image spatial extent) property in the
 * file's `meta` box declares, in pixels; null if there is none.
 *
 * ffmpeg's `-max_pixels` bounds each decoder, and in a HEIC that is one 512 px
 * tile. This refuses a file that openly claims to be enormous, against the same
 * ceiling sharp gets, before ffmpeg sees it; it does not bound the canvas a
 * crafted grid makes ffmpeg stitch (see `oneAtATime`).
 */
export function largestDeclaredPixels(header: Uint8Array): number | null {
	const view = new DataView(header.buffer, header.byteOffset, header.byteLength);
	const type = (at: number) => String.fromCharCode(...header.subarray(at, at + 4));
	// Top-level boxes until `meta`; its children are searched for `ispe`.
	let offset = 0;
	while (offset + 8 <= header.byteLength) {
		let size = view.getUint32(offset);
		if (size === 1 && offset + 16 <= header.byteLength) {
			size = Number(view.getBigUint64(offset + 8));
		}
		if (size < 8) return null;
		if (type(offset + 4) === 'meta') {
			const end = Math.min(offset + size, header.byteLength);
			let largest: number | null = null;
			// ispe is a FullBox: size, 'ispe', version+flags, width, height.
			for (let i = offset + 8; i + 16 <= end; i++) {
				if (type(i) !== 'ispe') continue;
				const pixels = view.getUint32(i + 8) * view.getUint32(i + 12);
				largest = Math.max(largest ?? 0, pixels);
			}
			return largest;
		}
		offset += size;
	}
	return null;
}

/**
 * Convert the HEIC at `sourceAbs` to a JPEG at `outputAbs`, upright. Throws
 * `HeicConversionError` for a file that isn't a readable, reasonably sized
 * HEIC; never leaves a partial output behind as a success.
 */
export async function convertHeicToJpeg(sourceAbs: string, outputAbs: string): Promise<void> {
	const handle = await open(sourceAbs, 'r');
	let header: Uint8Array;
	try {
		const buf = new Uint8Array(HEADER_BYTES);
		const { bytesRead } = await handle.read(buf, 0, HEADER_BYTES, 0);
		header = buf.subarray(0, bytesRead);
	} finally {
		await handle.close();
	}
	const declared = largestDeclaredPixels(header);
	if (declared === null) throw new HeicConversionError('Not a HEIC photo this server can read');
	if (declared > MAX_DECODE_PIXELS) {
		throw new HeicConversionError(
			`Photo is too large to convert (${declared} pixels; max ${MAX_DECODE_PIXELS})`,
		);
	}

	try {
		await oneAtATime(() =>
			runFfmpeg(
				[
					'-hide_banner',
					'-loglevel',
					'error',
					'-nostdin',
					'-threads',
					'1',
					// Per tile decoder, not the stitched canvas; see `oneAtATime`.
					'-max_pixels',
					String(MAX_DECODE_PIXELS),
					// Only the file protocol: a distro ffmpeg (supported, see
					// docs/deployment.md) carries every demuxer, and this file is an
					// upload nobody has inspected past its first few boxes.
					'-protocol_whitelist',
					'file',
					'-i',
					sourceAbs,
					'-frames:v',
					'1',
					'-q:v',
					HEIC_JPEG_QSCALE,
					'-f',
					'image2',
					'-y',
					outputAbs,
				],
				HEIC_TIMEOUT_MS,
				outputAbs,
			),
		);
	} catch (e) {
		throw new HeicConversionError('Could not convert this HEIC photo', { cause: e });
	}
}
