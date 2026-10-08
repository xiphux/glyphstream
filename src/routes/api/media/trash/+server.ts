import { json } from '@sveltejs/kit';
import { requireUser } from '$lib/server/auth/guard';
import { listTrashForUser } from '$lib/server/db/queries/media';
import { toTrashedMediaItem } from '$lib/server/media/trash-api';
import type { RequestHandler } from './$types';

/** The caller's "Recently deleted" media, most recently deleted first. */
export const GET: RequestHandler = async ({ locals }) => {
	requireUser(locals);
	return json(listTrashForUser(locals.user.id).map(toTrashedMediaItem));
};
