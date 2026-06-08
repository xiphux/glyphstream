import { error } from '@sveltejs/kit';
import { listSkillsForUser } from '$lib/server/db/queries/skills';
import type { PageServerLoad } from './$types';

/**
 * SSR the user's skills so the list paints with real data on first load.
 * `await parent()` first per the (app) page convention — without it the
 * locals.user!.id deref races the layout's redirect-on-no-auth and surfaces
 * as a 500 instead of a 302.
 *
 * Tagged `app:skills` (shared with the (app) layout's `enabledSkills`) so a
 * mutation can `invalidate('app:skills')` to refresh BOTH this list and the
 * composer's /skill autocomplete in one shot.
 */
export const load: PageServerLoad = async ({ locals, parent, depends }) => {
	await parent();
	if (!locals.user) throw error(401, 'Authentication required');
	depends('app:skills');
	return { skills: listSkillsForUser(locals.user.id) };
};
