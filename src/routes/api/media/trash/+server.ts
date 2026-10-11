import { requireUser } from '#lib/server/auth/guard.js';
import { listTrashForUser } from '#lib/server/db/queries/media.js';
import { toTrashedMediaItem } from '#lib/server/media/trash-api.js';
import type { RequestHandler } from './$types';

/** The caller's "Recently deleted" media, most recently deleted first. */
export const GET: RequestHandler = async ({ locals }) => {
	requireUser(locals);
	return Response.json(listTrashForUser(locals.user.id).map(toTrashedMediaItem));
};
