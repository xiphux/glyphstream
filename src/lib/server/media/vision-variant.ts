/**
 * Lazy downscaled variants of images bound for a vision model's context.
 *
 * Why: a chat request inlines every image in the branch as a base64 data URL, on
 * every turn, for the life of the conversation. A 4 MB phone photo isn't a 4 MB
 * cost paid once — it's ~5.4 MB of base64 re-uploaded on turn 2, turn 3, turn 20,
 * and it permanently occupies context the model must re-read each time. Meanwhile
 * every current vision model downscales internally before tiling, so the pixels
 * above ~1568px on the long edge are computed, transmitted, and then thrown away.
 *
 * So: inline a downscaled JPEG instead. The ORIGINAL IS NEVER TOUCHED — it stays
 * on disk for the gallery, for downloads, and for image-to-image dispatch (which
 * goes through `loadMediaBytes`, not this path, and genuinely wants full pixels).
 *
 * Lazy, same as `thumbnail.ts`: generated on first inline, cached as a sibling
 * file, so existing conversations pick it up with no backfill migration. Failure
 * to encode is non-fatal — callers fall back to the original bytes, exactly as
 * before this module existed.
 *
 * DISK-STORE-ONLY, for the same reason `thumbnail.ts` is: it resolves raw
 * `node:fs` paths under `mediaDir()` rather than going through the MediaStore
 * interface. Under a future S3 store this degrades to "no variant" (null), and
 * the caller inlines the original — slower and fatter, but correct. Extending
 * MediaStore with derived-asset methods is the same deferred v2 change noted
 * there.
 */

import sharp from 'sharp';
import { Buffer } from 'node:buffer';
import { existsSync, mkdirSync } from 'node:fs';
import { readFile, rename, stat, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { mediaDir } from '../env';
import { getVisionConfig } from '../endpoints/config';

/** Convention mirrors `thumbStoragePath`: variants live as `{original}.vision.jpg`
 *  siblings, so a glob finds them and `disk-store.delete` can unlink them with
 *  the original. */
export function visionStoragePath(storagePath: string): string {
	return `${storagePath}.vision.jpg`;
}

export interface VisionVariant {
	bytes: Buffer;
	contentType: 'image/jpeg';
}

/**
 * Size of the ALREADY-CACHED variant for `storagePath`, or null if there isn't
 * one. Deliberately stat-only: this backs the read-only context-breakdown probe,
 * which must not sit there re-encoding a gallery's worth of images just because
 * someone opened a panel. Before an image has been sent once, its variant doesn't
 * exist yet and the caller correctly falls back to pricing the original.
 */
export async function cachedVisionVariantSize(storagePath: string): Promise<number | null> {
	if (getVisionConfig().maxImageDim <= 0) return null;
	try {
		return (await stat(resolve(mediaDir(), visionStoragePath(storagePath)))).size;
	} catch {
		return null;
	}
}

/**
 * The downscaled JPEG to inline for `storagePath`, or null to inline the original.
 *
 * Null is returned whenever the variant wouldn't be a win — downscaling disabled,
 * source unreadable, sharp can't decode it, or (the common case for a small PNG
 * icon) the re-encode came out no smaller than what we started with. Callers must
 * treat null as "use the original", never as an error.
 */
/**
 * Storage paths whose re-encode came out no smaller than the original, so the
 * variant was declined. WITHOUT this, every such image is fully decoded and
 * mozjpeg-encoded again on EVERY turn, forever — paying the most expensive part
 * of the pipeline to reach the same "no thanks" each time. There's no cached
 * artifact to short-circuit on, precisely because we decided not to write one.
 *
 * In-memory rather than an on-disk marker: it costs one wasted re-encode per
 * image per process restart, and it adds no new file to reap in `disk-store.delete`.
 * Bounded so a long-lived server with a big gallery can't grow it without limit.
 */
const declined = new Set<string>();
const DECLINED_MAX = 4096;

export async function getVisionVariant(storagePath: string): Promise<VisionVariant | null> {
	const { maxImageDim, imageQuality } = getVisionConfig();
	if (maxImageDim <= 0) return null; // explicitly disabled
	if (declined.has(storagePath)) return null;

	const root = resolve(mediaDir());
	const sourceAbs = resolve(root, storagePath);
	if (!existsSync(sourceAbs)) return null;

	const variantAbs = resolve(root, visionStoragePath(storagePath));
	if (existsSync(variantAbs)) {
		try {
			return { bytes: await readFile(variantAbs), contentType: 'image/jpeg' };
		} catch (e) {
			// A cached variant we can't read is not worth failing the send over —
			// fall through and regenerate it.
			console.warn(`[vision-variant] cached variant unreadable for ${storagePath}:`, e);
		}
	}

	mkdirSync(dirname(variantAbs), { recursive: true });
	try {
		const original = await readFile(sourceAbs);
		const encoded = await sharp(original)
			.resize(maxImageDim, maxImageDim, { fit: 'inside', withoutEnlargement: true })
			// JPEG has no alpha. Without an explicit flatten, sharp composites
			// transparency onto BLACK — which turns a transparent-background diagram
			// or a dark-mode screenshot into an unreadable smear. White matches how
			// these images are viewed in practice.
			.flatten({ background: '#ffffff' })
			.jpeg({ quality: imageQuality, mozjpeg: true })
			.toBuffer();

		// Re-encoding a small, already-efficient image can come out BIGGER (a 200px
		// JPEG icon round-tripped through sharp, say). Inlining that would make the
		// payload worse while also losing quality, so keep the original instead —
		// and remember, so we don't pay the decode again next turn.
		if (encoded.byteLength >= original.byteLength) {
			if (declined.size >= DECLINED_MAX) declined.clear();
			declined.add(storagePath);
			return null;
		}

		// Cache only what we'll actually use, and write the buffer verbatim — running
		// it back through sharp would re-encode an already-lossy JPEG a second time.
		// Atomic rename (as in disk-store) so a torn write can't poison the cache:
		// a half-written variant would be served as a corrupt image on every
		// subsequent turn.
		//
		// The temp name must be unique PER CALL, not per process: a multi-model
		// fan-out sends the same fresh image from several concurrent requests, and a
		// pid-keyed path would have them writing one file underneath each other. With
		// distinct temps the renames are independent and whichever lands last wins —
		// both hold identical, complete bytes.
		const tmp = `${variantAbs}.${randomUUID()}.tmp`;
		await writeFile(tmp, encoded);
		await rename(tmp, variantAbs);
		return { bytes: encoded, contentType: 'image/jpeg' };
	} catch (e) {
		// Corrupt file, exotic codec, unreadable — degrade to the original rather
		// than take down the send.
		console.warn(`[vision-variant] generation failed for ${storagePath}:`, e);
		return null;
	}
}
