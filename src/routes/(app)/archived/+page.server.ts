import { listArchivedConversations } from '$lib/server/db/queries/conversations';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals, parent }) => {
	// Wait for the (app) layout's auth check before deref'ing locals.user.
	// See /(app)/+page.server.ts for why.
	await parent();
	return {
		archivedConversations: listArchivedConversations(locals.user!.id),
	};
};
