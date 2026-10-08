import { error, json } from '@sveltejs/kit';
import { requireUser } from '$lib/server/auth/guard';
import { parseJsonBody } from '$lib/server/http';
import { purgeTrashForUser } from '$lib/server/db/queries/media';
import { unlinkMediaFiles } from '$lib/server/media/disk-store';
import { parseTrashIds } from '$lib/server/media/trash-api';
import type { RequestHandler } from './$types';

/**
 * "Delete forever" from the trash. Body `{ ids: string[] }` for a selection, or
 * `{ all: true }` to empty it. Returns `{ purged: N }`.
 *
 * Bytes are unlinked after the rows commit — doing it inside the transaction
 * would let a rollback strand rows pointing at deleted files. See
 * unlinkMediaFiles, which also swallows a failed unlink (the file leaks; the
 * request doesn't 500).
 */
export const POST: RequestHandler = async ({ locals, request }) => {
	requireUser(locals);
	const body = await parseJsonBody<{ ids?: unknown; all?: unknown }>(request);
	if (body.all !== undefined && body.all !== true) error(400, "'all' must be true when present");
	const purged = purgeTrashForUser(body.all === true ? 'all' : parseTrashIds(body), locals.user.id);
	await unlinkMediaFiles(purged, 'media.trash.purge');
	return json({ purged: purged.length });
};
