import { error } from '@sveltejs/kit';
import { hardDeleteMediaForUser } from '$lib/server/db/queries/media';
import { getMediaStore } from '$lib/server/media/disk-store';
import type { RequestHandler } from './$types';

/**
 * Manual hard-delete from the gallery. Marks the row hard-deleted
 * immediately and unlinks the bytes from disk; old conversation messages
 * that referenced this media will subsequently 404 on /content (graceful
 * broken-image in the UI). Idempotent: a 404 here means the row was already
 * gone or already hard-deleted.
 */
export const DELETE: RequestHandler = async ({ locals, params }) => {
	if (!locals.user) throw error(401, 'Authentication required');
	const result = hardDeleteMediaForUser(params.id, locals.user.id);
	if (!result) throw error(404, 'Media not found');
	await getMediaStore().delete(result.storagePath);
	return new Response(null, { status: 204 });
};
