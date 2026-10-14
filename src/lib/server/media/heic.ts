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
import sharp, { type Metadata } from 'sharp';
import { MAX_DECODE_PIXELS } from './decode-limits';
import { FfmpegDeadline, runFfmpeg } from './ffmpeg';

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
	/** True when the failure is the server's, not the file's: no ffmpeg to run,
	 *  or a conversion that ran out of time. Worth a retry, or an operator's
	 *  attention, rather than telling the user their photo is unreadable. */
	readonly unavailable: boolean;
	constructor(message: string, options?: { cause?: unknown; unavailable?: boolean }) {
		super(message, options);
		this.name = 'HeicConversionError';
		this.unavailable = options?.unavailable ?? false;
	}
}

export interface DeclaredImage {
	/** The largest `ispe` (image spatial extent) any item in `meta` declares. */
	width: number;
	height: number;
	/** The first `irot` property's rotation, in quarter turns (0-3). */
	quarterTurns: number;
}

/**
 * What the file's `meta` box declares: the largest image any `ispe` property
 * gives, and the first `irot` rotation. Null when there is no `meta` box in the
 * header or no `ispe` in it.
 *
 * The size refuses a file that openly claims to be enormous, against the same
 * ceiling sharp gets, before ffmpeg sees it. It does not bound the canvas a
 * crafted grid makes ffmpeg stitch (`-max_pixels` bounds each 512 px tile's
 * decoder, not that); see `oneAtATime`. Both values also check the result:
 * see `convertHeicToJpeg`.
 */
export function readDeclaredImage(header: Uint8Array): DeclaredImage | null {
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
			let largest: DeclaredImage | null = null;
			let quarterTurns: number | null = null;
			for (let i = offset + 8; i + 5 <= end; i++) {
				const t = type(i);
				// ispe is a FullBox: size, 'ispe', version+flags, width, height.
				if (t === 'ispe' && i + 16 <= end) {
					const width = view.getUint32(i + 8);
					const height = view.getUint32(i + 12);
					if (!largest || width * height > largest.width * largest.height) {
						largest = { width, height, quarterTurns: 0 };
					}
				} else if (t === 'irot' && quarterTurns === null) {
					// irot: size, 'irot', one byte whose low two bits are the angle.
					quarterTurns = header[i + 4] & 3;
				}
			}
			return largest && { ...largest, quarterTurns: quarterTurns ?? 0 };
		}
		offset += size;
	}
	return null;
}

/** How far each output dimension may fall short of the declared one (a clean-
 *  aperture crop trims a few pixels) and still count as the whole photo. */
const SIZE_TOLERANCE = 0.9;

/**
 * Convert the HEIC at `sourceAbs` to a JPEG at `outputAbs`, upright. Throws
 * `HeicConversionError` for a file that isn't a readable, reasonably sized
 * HEIC, or when the JPEG isn't the whole photo the file declares, upright;
 * never reports a partial or wrong output as a success.
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
	const declared = readDeclaredImage(header);
	if (declared === null) throw new HeicConversionError('Not a HEIC photo this server can read');
	const declaredPixels = declared.width * declared.height;
	if (declaredPixels > MAX_DECODE_PIXELS) {
		throw new HeicConversionError(
			`Photo is too large to convert (${declaredPixels} pixels; max ${MAX_DECODE_PIXELS})`,
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
		if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
			throw new HeicConversionError(
				"HEIC photos can't be converted on this server (ffmpeg isn't installed)",
				{ cause: e, unavailable: true },
			);
		}
		if (e instanceof FfmpegDeadline || (e as { killed?: boolean }).killed === true) {
			throw new HeicConversionError('Converting this photo took too long; try again', {
				cause: e,
				unavailable: true,
			});
		}
		throw new HeicConversionError('Could not convert this HEIC photo', { cause: e });
	}

	// The JPEG is the only copy kept, so check it is the whole photo, upright.
	// An ffmpeg too old to stitch tiles or apply the rotation (older distro
	// builds) can still exit 0, having written one 512 px tile, the embedded
	// thumbnail, or the photo on its side; storing that would lose the photo.
	let out: Metadata;
	try {
		out = await sharp(outputAbs).metadata();
	} catch (e) {
		throw new HeicConversionError('Could not convert this HEIC photo', { cause: e });
	}
	const turned = declared.quarterTurns % 2 === 1;
	const wantW = turned ? declared.height : declared.width;
	const wantH = turned ? declared.width : declared.height;
	const near = (got: number | undefined, want: number) =>
		got !== undefined && got <= want && got >= want * SIZE_TOLERANCE;
	if (!near(out.width, wantW) || !near(out.height, wantH)) {
		throw new HeicConversionError('Could not convert this HEIC photo', {
			cause: new Error(
				`ffmpeg wrote ${out.width}x${out.height}, expected ${wantW}x${wantH}; ` +
					'it may be too old to read tiled or rotated HEIC (7.1 or newer is needed)',
			),
		});
	}
}
