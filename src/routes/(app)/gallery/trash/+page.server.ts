import { listTrashForUser } from '$lib/server/db/queries/media';
import { toTrashedMediaItem } from '$lib/server/media/trash-api';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals, parent, depends }) => {
	// Wait for the (app) layout's auth check before deref'ing locals.user.
	// The `uses.parent` coupling this buys is affordable here, unlike chat/[id]:
	// the list carries excerpts, not full prompts, and is bounded by the
	// retention window. The page's own mutations invalidate only `app:trash`, so
	// a restore doesn't re-run the layouts on top of this.
	depends('app:trash');
	await parent();
	return { items: listTrashForUser(locals.user!.id).map(toTrashedMediaItem) };
};
