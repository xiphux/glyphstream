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

import type { Buffer } from 'node:buffer';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { mediaDir } from '../env';
import { getMediaForUser } from '../db/queries/media';

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

/**
 * Load a stored media row's bytes off disk after verifying ownership.
 * Used by both the vision-chat data-URL path and the I2I multipart path.
 *
 * Refuses `kind: 'file'` rows — those are user/file-attachment uploads
 * (xlsx, csv, pdf, ...) that mean nothing as image-inputs to the vision
 * model. The code interpreter has its own materialization path through
 * the MediaStore; routing files into a vision-shaped data URL would
 * either confuse the upstream or expose the bytes of an internal
 * document to a model that can't read them.
 *
 * Throws `MediaNotAvailableError` for permanently-unavailable media
 * (not found, hard-deleted, wrong kind, ENOENT). Transient filesystem
 * errors (EACCES, EIO, …) propagate as-is — see the class doc for why.
 */
export async function loadMediaBytes(mediaId: string, userId: string): Promise<LoadedMediaBytes> {
	const row = getMediaForUser(mediaId, userId);
	if (!row) throw new MediaNotAvailableError(mediaId, 'not found');
	if (row.hardDeletedAt !== null) throw new MediaNotAvailableError(mediaId, 'deleted');
	if (row.kind !== 'image' && row.kind !== 'video') {
		throw new MediaNotAvailableError(mediaId, `kind '${row.kind}' cannot be inlined`);
	}
	const fullPath = resolve(mediaDir(), row.storagePath);
	try {
		const bytes = await readFile(fullPath);
		return { bytes, contentType: row.contentType, kind: row.kind };
	} catch (e) {
		if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
			throw new MediaNotAvailableError(mediaId, 'file not found');
		}
		throw e;
	}
}

export async function mediaIdToDataUrl(mediaId: string, userId: string): Promise<string> {
	const { bytes, contentType } = await loadMediaBytes(mediaId, userId);
	const b64 = bytes.toString('base64');
	return `data:${contentType};base64,${b64}`;
}
