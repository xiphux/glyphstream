import { error } from '@sveltejs/kit';
import { listMemoriesForUser } from '$lib/server/db/queries/memories';
import type { PageServerLoad } from './$types';

/**
 * SSR the user's saved memories so the list paints with real data on
 * first load. `await parent()` first per the (app) page convention —
 * without it, the locals.user!.id deref races the layout's
 * redirect-on-no-auth and surfaces as a 500 instead of a 302.
 */
export const load: PageServerLoad = async ({ locals, parent }) => {
	await parent();
	if (!locals.user) throw error(401, 'Authentication required');
	const memories = listMemoriesForUser(locals.user.id);
	return { memories };
};
