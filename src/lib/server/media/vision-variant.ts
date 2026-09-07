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
 * `node:fs` paths — the original under `mediaDir()`, the variant under
 * `derivedDir()` — rather than going through the MediaStore interface. Under a future S3 store this degrades to "no variant" (null), and
 * the caller inlines the original — slower and fatter, but correct. Extending
 * MediaStore with derived-asset methods is the same deferred v2 change noted
 * there.
 */

import sharp from 'sharp';
import { Buffer } from 'node:buffer';
import { mkdirSync } from 'node:fs';
import { readFile, rename, stat, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { derivedDir, mediaDir } from '../env';
import { getVisionConfig } from '../endpoints/config';

/** Convention mirrors `thumbStoragePath`: the original's RELATIVE path plus
 *  `.vision.jpg`, under `derivedDir()` — beside the original unless DERIVED_DIR
 *  points elsewhere. Derived from the original's path either way, so a glob
 *  finds them under one root and `disk-store.delete` can unlink them with it. */
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
		return (await stat(resolve(derivedDir(), visionStoragePath(storagePath)))).size;
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

/**
 * Read a file, or null if reading it didn't work.
 *
 * `what` names the file for the log line. A MISSING file is never logged — that
 * is the ordinary miss this function exists to report, and both callers reach it
 * routinely. Anything else is a real filesystem problem and gets a line, because
 * the caller degrades to "inline the original" either way and would otherwise
 * leave no trace of a volume that has stopped answering.
 *
 * Nothing here may throw: every caller's fallback is that same inline, and a
 * send must not fail over a cache that didn't cooperate.
 */
async function readFileOrNull(path: string, what: string): Promise<Buffer | null> {
	try {
		return await readFile(path);
	} catch (e) {
		if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
			console.warn(`[vision-variant] ${what} unreadable:`, e);
		}
		return null;
	}
}

export async function getVisionVariant(storagePath: string): Promise<VisionVariant | null> {
	const { maxImageDim, imageQuality } = getVisionConfig();
	if (maxImageDim <= 0) return null; // explicitly disabled
	if (declined.has(storagePath)) return null;

	// Two roots: the original is large and irreplaceable, the variant is small,
	// re-read every turn, and costs one re-encode to rebuild. They coincide
	// unless DERIVED_DIR is set — see `derivedDir` in env.ts.
	const sourceAbs = resolve(mediaDir(), storagePath);
	const variantAbs = resolve(derivedDir(), visionStoragePath(storagePath));

	// Ask for the cached variant's BYTES first and let the read itself answer
	// "is it there". An existsSync ahead of the readFile spends a second round
	// trip on an answer the read already carries, and spends it on the event
	// loop — and this is the hot path by a wide margin, since an image is
	// re-inlined on every turn for the life of the conversation and only the
	// first of those turns generates.
	//
	// Checking the ORIGINAL's existence before that (which is what this used to
	// do) was the same round trip a third time, against a file this path never
	// touches again once a variant is cached. All three are free on a local
	// disk; none of them are once MEDIA_DIR is a remote mount.
	const cached = await readFileOrNull(variantAbs, `cached variant for ${storagePath}`);
	if (cached !== null) return { bytes: cached, contentType: 'image/jpeg' };

	// A media row can outlive its bytes, so a MISSING original is ordinary and
	// `readFileOrNull` stays quiet about it. An original that is present but
	// unreadable is not ordinary, and it is the failure a remote MEDIA_DIR
	// actually produces — a soft NFS mount reports EIO, not ENOENT. Suppressing
	// that would leave a volume that had stopped answering degrading every image
	// in silence.
	const original = await readFileOrNull(sourceAbs, `original for ${storagePath}`);
	if (original === null) return null;

	try {
		// Inside the try, not ahead of it. This creates a directory under
		// DERIVED_DIR, which since that became separately configurable may be a
		// volume that is absent, read-only, or unmounted while MEDIA_DIR is
		// perfectly healthy — EACCES and EROFS are reachable here in a way they
		// were not when the two roots were the same directory and the original
		// had already been read out of it. Throwing would break this function's
		// contract (see the header: a send must not fail over a cache that
		// didn't cooperate) and take down the request; the catch below degrades
		// to inlining the original, which is the right answer.
		mkdirSync(dirname(variantAbs), { recursive: true });

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
