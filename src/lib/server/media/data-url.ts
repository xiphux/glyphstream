/**
 * Convert a stored media row into a base64 data URL for inlining into
 * upstream requests.
 *
 * Why data URLs instead of pass-through URLs: the upstream model server
 * (OpenAI, Anthropic, llama-server, the bridge) needs to actually fetch
 * the image. For self-hosted setups behind a NAS/reverse-proxy, it's
 * not always reachable from the upstream's perspective — and our
 * /api/media/:id/content endpoint is auth-gated anyway. Embedding the
 * bytes as a data URL works in every topology at the cost of a
 * larger payload (~33% base64 overhead). Optimization for "upstream is
 * on the same network, give it a signed URL" is a v2 concern.
 */

import { Buffer } from 'node:buffer';
import { getMediaForUser } from '../db/queries/media';
import { getMediaStore } from './disk-store';
import { getVisionVariant } from './vision-variant';

/**
 * Thrown by `loadMediaBytes` when the media is permanently unavailable:
 * row not found, hard-deleted, wrong kind, or file missing from disk
 * (ENOENT). Catchers in the send path use this to degrade gracefully
 * rather than crash the whole request. Transient disk I/O errors
 * (EACCES, EIO, …) still propagate as raw `Error`s — a blanket catch
 * would incorrectly tell the model an image was deleted when it was
 * merely momentarily unreadable.
 */
export class MediaNotAvailableError extends Error {
	constructor(mediaId: string, detail: string) {
		super(`Media ${mediaId} is not available: ${detail}`);
		this.name = 'MediaNotAvailableError';
	}
}

export interface LoadedMediaBytes {
	bytes: Buffer;
	contentType: string;
	kind: 'image' | 'video';
}

/** An inlineable media row: exists, owned by the caller, not hard-deleted, and
 *  an image or video rather than a document. */
interface InlineableMedia {
	storagePath: string;
	contentType: string;
	kind: 'image' | 'video';
}

/**
 * Validate that a media row may be inlined, WITHOUT reading its bytes.
 *
 * Split out from `loadMediaBytes` so the vision path can check a cached
 * downscaled variant before deciding whether the (potentially multi-megabyte)
 * original ever needs to come off disk.
 *
 * Refuses `kind: 'file'` rows — those are user/file-attachment uploads
 * (xlsx, csv, pdf, ...) that mean nothing as image-inputs to a vision
 * model. The code interpreter mounts files through the same MediaStore
 * interface; routing them into a vision-shaped data URL would either
 * confuse the upstream or expose the bytes of an internal document to
 * a model that can't read them.
 */
function requireInlineable(mediaId: string, userId: string): InlineableMedia {
	const row = getMediaForUser(mediaId, userId);
	if (!row) throw new MediaNotAvailableError(mediaId, 'not found');
	if (row.hardDeletedAt !== null) throw new MediaNotAvailableError(mediaId, 'deleted');
	if (row.kind !== 'image' && row.kind !== 'video') {
		throw new MediaNotAvailableError(mediaId, `kind '${row.kind}' cannot be inlined`);
	}
	return { storagePath: row.storagePath, contentType: row.contentType, kind: row.kind };
}

/** Read a validated row's bytes through the MediaStore. */
async function readBytes(mediaId: string, row: InlineableMedia): Promise<Buffer> {
	const store = getMediaStore();
	const result = await store.open(row.storagePath, row.contentType);
	if (!result) throw new MediaNotAvailableError(mediaId, 'file not found');
	const chunks: Buffer[] = [];
	for await (const chunk of result.stream) {
		chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
	}
	return Buffer.concat(chunks);
}

/**
 * Load a stored media row's bytes off disk after verifying ownership.
 * Used by both the vision-chat data-URL path and the I2I multipart path.
 *
 * Always returns the ORIGINAL bytes at full resolution. The vision path's
 * downscaling lives in `mediaIdToDataUrl`, not here, precisely so that
 * image-to-image dispatch — which asks a generation model to reproduce detail —
 * keeps every pixel.
 *
 * Throws `MediaNotAvailableError` for permanently-unavailable media
 * (not found, hard-deleted, wrong kind, ENOENT). Transient filesystem
 * errors (EACCES, EIO, …) propagate as-is — see the class doc for why.
 */
export async function loadMediaBytes(mediaId: string, userId: string): Promise<LoadedMediaBytes> {
	const row = requireInlineable(mediaId, userId);
	return { bytes: await readBytes(mediaId, row), contentType: row.contentType, kind: row.kind };
}

/**
 * Data URL to inline into a chat request for a stored image.
 *
 * Images are re-sent on EVERY turn for the life of the conversation, so this is
 * the one path where the bytes are worth shrinking: it prefers a downscaled JPEG
 * variant (see `vision-variant.ts`) over the original. Videos, and any image the
 * variant path declines (downscaling disabled, undecodable, or already smaller
 * than the re-encode), fall back to the original bytes — so the worst case is
 * exactly the old behavior.
 *
 * Deliberately NOT used by image-to-image dispatch, which calls `loadMediaBytes`
 * directly and wants full resolution: a generation model is being asked to
 * reproduce detail, whereas a vision model is being asked to read a picture that
 * it would have downscaled internally anyway.
 */
export async function mediaIdToDataUrl(mediaId: string, userId: string): Promise<string> {
	const row = requireInlineable(mediaId, userId);
	if (row.kind === 'image') {
		// Checked before the original is read, so a cache hit never pulls the
		// full-resolution bytes off disk at all — which is the point, since this
		// runs once per image per turn for the whole life of the conversation.
		const variant = await getVisionVariant(row.storagePath);
		if (variant) {
			return `data:${variant.contentType};base64,${variant.bytes.toString('base64')}`;
		}
	}
	const bytes = await readBytes(mediaId, row);
	return `data:${row.contentType};base64,${bytes.toString('base64')}`;
}
