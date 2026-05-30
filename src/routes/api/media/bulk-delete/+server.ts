import { error, json } from '@sveltejs/kit';
import { requireUser } from '$lib/server/auth/guard';
import { parseJsonBody } from '$lib/server/http';
import { bulkHardDeleteMediaForUser } from '$lib/server/db/queries/media';
import { unlinkMediaFiles } from '$lib/server/media/disk-store';
import type { RequestHandler } from './$types';

/**
 * Hard cap on a single bulk-delete request. Matches the gallery listing
 * page-size ceiling (200 in /api/media GET) so a "select everything
 * visible, delete" flow can't blow past what a single page loads.
 */
const MAX_BULK_DELETE = 200;

/**
 * Bulk gallery delete. Body shape: `{ ids: string[] }`. Per-row semantics
 * match the single-id DELETE — already-deleted / cross-user / unknown ids
 * are silently dropped from the count rather than failing the whole
 * request. Returns `{ deleted: N }` with the number actually tombstoned;
 * the client uses this to confirm completion + log a sensible toast.
 *
 * POST rather than DELETE-with-body because some reverse proxies strip
 * the body off a DELETE — the deployment story for this app is "self-
 * hosted behind whatever proxy," and POST sidesteps that hazard.
 */
export const POST: RequestHandler = async ({ locals, request }) => {
	requireUser(locals);

	const body = await parseJsonBody<{ ids?: unknown }>(request);
	if (!Array.isArray(body.ids)) {
		throw error(400, "'ids' must be an array of media id strings");
	}
	const ids: string[] = [];
	for (const v of body.ids) {
		if (typeof v !== 'string' || v.length === 0) {
			throw error(400, "'ids' entries must be non-empty strings");
		}
		ids.push(v);
	}
	if (ids.length > MAX_BULK_DELETE) {
		throw error(400, `Too many ids in one request (max ${MAX_BULK_DELETE})`);
	}

	const deleted = bulkHardDeleteMediaForUser(ids, locals.user.id);
	await unlinkMediaFiles(deleted, 'media.bulk-delete');
	return json({ deleted: deleted.length });
};
