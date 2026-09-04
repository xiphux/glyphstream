import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';

/**
 * SSR the user's current preferences so the form renders with real values
 * on first paint. Without this we'd flash defaults briefly while a client-
 * side GET races; saving the form would then potentially clobber a real
 * value the user hadn't typed.
 */
export const load: PageServerLoad = async ({ locals, parent }) => {
	// Reuse the layout's `prefs` instead of re-reading and re-parsing them. The
	// (app) layout already loads them for every page (the composer needs
	// enterBehavior on first paint), and re-reading here re-ran the full
	// coerceUserPreferences walk and serialized a *second* copy of the blob into
	// this page's data.
	// `featureCategories` rides along from the same parent load — the (app)
	// layout already assembles built-ins + connected MCP servers for the
	// composer's toggle menu, and the default-toggles section here needs exactly
	// that list. Re-deriving it would mean a second `listServerCatalog()` walk
	// for an identical answer.
	const { prefs, featureCategories } = await parent();
	if (!locals.user) error(401, 'Authentication required');
	if (!prefs) error(404, 'User not found');
	return { prefs, featureCategories };
};
