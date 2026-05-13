import { error } from '@sveltejs/kit';
import { getUserPreferences } from '$lib/server/db/queries/user-preferences';
import type { PageServerLoad } from './$types';

/**
 * SSR the user's current preferences so the form renders with real values
 * on first paint. Without this we'd flash defaults briefly while a client-
 * side GET races; saving the form would then potentially clobber a real
 * value the user hadn't typed.
 */
export const load: PageServerLoad = async ({ locals, parent }) => {
	await parent();
	if (!locals.user) throw error(401, 'Authentication required');
	const prefs = getUserPreferences(locals.user.id);
	if (!prefs) throw error(404, 'User not found');
	return { prefs };
};
