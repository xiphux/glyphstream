/**
 * POST /api/uploads
 *
 * Accepts a multipart upload of a single image and stores it via MediaStore
 * + a `media` row with `origin = 'uploaded'`. Returns the new media id so
 * the client can stash it alongside any composer state and forward it on
 * the next message-send call.
 *
 * Eager-upload pattern: we POST the file as soon as the user picks it,
 * rather than waiting until they hit Send. Wins: instant per-file progress,
 * faster send, and no big payload during the streaming chat request. The
 * orphan-file problem (user picks a file but never sends) is handled by
 * the existing media purger — uploads are stamped with `unreferenced_since
 * = now` on insert, so abandoned uploads are swept after the grace period.
 *
 * v1 scope is image-only (no video uploads, no documents). The upstream
 * paths that consume attachments — vision chat, image edits, video
 * input_reference — all want images.
 */

import { Buffer } from 'node:buffer';
import { error, json } from '@sveltejs/kit';
import { insertMedia } from '$lib/server/db/queries/media';
import { getMediaStore } from '$lib/server/media/disk-store';
import type { RequestHandler } from './$types';

const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;
const ALLOWED_PREFIXES = ['image/'] as const;

export const POST: RequestHandler = async ({ locals, request }) => {
	if (!locals.user) throw error(401, 'Authentication required');

	let form: FormData;
	try {
		form = await request.formData();
	} catch {
		throw error(400, 'Body must be multipart/form-data');
	}

	const file = form.get('file');
	if (!(file instanceof File)) {
		throw error(400, 'Missing "file" field');
	}

	const contentType = file.type || 'application/octet-stream';
	if (!ALLOWED_PREFIXES.some((p) => contentType.startsWith(p))) {
		throw error(415, `Unsupported content type: ${contentType}`);
	}

	if (file.size > MAX_UPLOAD_BYTES) {
		throw error(
			413,
			`File too large (${file.size} bytes; max ${MAX_UPLOAD_BYTES})`
		);
	}

	// `file.size` is reliable but `file.arrayBuffer()` may yield zero bytes
	// for an empty file or a corrupted upload. Check after read.
	const bytes = Buffer.from(await file.arrayBuffer());
	if (bytes.byteLength === 0) {
		throw error(400, 'Empty file');
	}

	const store = getMediaStore();
	const ref = await store.put({ bytes, contentType, kind: 'image' });

	const { id } = insertMedia({
		userId: locals.user.id,
		storagePath: ref.storagePath,
		contentType: ref.contentType,
		byteSize: ref.byteSize,
		kind: 'image',
		sourceEndpointId: null,
		sourceModel: null,
		promptExcerpt: null,
		origin: 'uploaded'
	});

	return json({
		id,
		contentType: ref.contentType,
		byteSize: ref.byteSize,
		kind: 'image' as const
	});
};
