import { error, json } from '@sveltejs/kit';
import { requireUser } from '$lib/server/auth/guard';
import {
	getMediaListItemForUser,
	hardDeleteMediaForUser
} from '$lib/server/db/queries/media';
import { unlinkMediaFiles } from '$lib/server/media/disk-store';
import type { RequestHandler } from './$types';

/**
 * Metadata fetch for a single media row, in the same MediaListItem shape
 * the gallery uses. Drives the chat-side lightbox: message parts only
 * carry `mediaId`, so the source model + prompt excerpt + size etc. need
 * a one-shot fetch when the user taps an image. Ownership-checked.
 */
export const GET: RequestHandler = async ({ locals, params }) => {
	requireUser(locals);
	const m = getMediaListItemForUser(params.id, locals.user.id);
	if (!m) throw error(404, 'Media not found');
	return json(m);
};

/**
 * Manual hard-delete from the gallery. Marks the row hard-deleted
 * immediately and unlinks the bytes from disk; old conversation messages
 * that referenced this media will subsequently 404 on /content (graceful
 * broken-image in the UI). Idempotent: a 404 here means the row was already
 * gone or already hard-deleted.
 */
export const DELETE: RequestHandler = async ({ locals, params }) => {
	requireUser(locals);
	const result = hardDeleteMediaForUser(params.id, locals.user.id);
	if (!result) throw error(404, 'Media not found');
	// Unlink the bytes after the row is gone. unlinkMediaFiles swallows a
	// failed unlink so a leaked file can't turn this delete into a 500.
	await unlinkMediaFiles(
		[{ id: params.id, storagePath: result.storagePath }],
		'media.delete'
	);
	return new Response(null, { status: 204 });
};
