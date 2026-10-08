import { listTrashForUser } from '$lib/server/db/queries/media';
import { toTrashedMediaItem } from '$lib/server/media/trash-api';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals, parent }) => {
	// Wait for the (app) layout's auth check before deref'ing locals.user.
	// The payload is small (ids + excerpts, bounded by the retention window),
	// so the `uses.parent` coupling this buys is cheap here — unlike chat/[id].
	await parent();
	return { items: listTrashForUser(locals.user!.id).map(toTrashedMediaItem) };
};
