import { json } from '@sveltejs/kit';
import { requireUser } from '$lib/server/auth/guard';
import { parseJsonBody } from '$lib/server/http';
import { restoreMediaForUser } from '$lib/server/db/queries/media';
import { parseTrashIds } from '$lib/server/media/trash-api';
import type { RequestHandler } from './$types';

/**
 * Put trashed media back in the gallery. Body `{ ids: string[] }`; ids that
 * aren't the caller's, aren't in the trash, or were already purged are dropped
 * silently, like the bulk delete. Returns `{ restored: N }`.
 */
export const POST: RequestHandler = async ({ locals, request }) => {
	requireUser(locals);
	const ids = parseTrashIds(await parseJsonBody<{ ids?: unknown }>(request));
	return json({ restored: restoreMediaForUser(ids, locals.user.id).length });
};
