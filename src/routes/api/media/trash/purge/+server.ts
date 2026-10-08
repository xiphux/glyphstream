import { error, json } from '@sveltejs/kit';
import { requireUser } from '$lib/server/auth/guard';
import { parseJsonBody } from '$lib/server/http';
import { purgeTrashForUser } from '$lib/server/db/queries/media';
import { unlinkMediaFiles } from '$lib/server/media/disk-store';
import { parseTrashIds } from '$lib/server/media/trash-api';
import type { RequestHandler } from './$types';

/**
 * "Delete forever" from the trash. Body `{ ids: string[] }` for a selection, or
 * `{ deletedUpTo: number }` to empty it — the newest `deletedAt` the page
 * showed, so a delete that landed after the page loaded survives (see
 * purgeTrashForUser). Returns `{ purged: N }`.
 *
 * Bytes are unlinked after the rows commit — doing it inside the transaction
 * would let a rollback strand rows pointing at deleted files. See
 * unlinkMediaFiles, which also swallows a failed unlink (the file leaks; the
 * request doesn't 500).
 */
export const POST: RequestHandler = async ({ locals, request }) => {
	requireUser(locals);
	const body = await parseJsonBody<{ ids?: unknown; deletedUpTo?: unknown }>(request);
	let which: string[] | { deletedUpTo: number };
	if (body.deletedUpTo !== undefined) {
		if (typeof body.deletedUpTo !== 'number' || !Number.isFinite(body.deletedUpTo)) {
			error(400, "'deletedUpTo' must be a timestamp");
		}
		which = { deletedUpTo: body.deletedUpTo };
	} else {
		which = parseTrashIds(body);
	}
	const purged = purgeTrashForUser(which, locals.user.id);
	await unlinkMediaFiles(purged, 'media.trash.purge');
	return json({ purged: purged.length });
};
