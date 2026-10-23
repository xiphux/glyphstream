import { error } from '@sveltejs/kit';
import { getUserPreferences } from '#lib/server/db/queries/user-preferences.js';
import type { PageServerLoad } from './$types';

/**
 * SSR the user's current preferences so the form renders with real values
 * on first paint. Without this we'd flash defaults briefly while a client-
 * side GET races; saving the form would then potentially clobber a real
 * value the user hadn't typed.
 */
export const load: PageServerLoad = async ({ locals, parent }) => {
	// `featureCategories` rides along from the parent load — the (app) layout
	// already assembles built-ins + connected MCP servers for the composer's
	// toggle menu, and the default-toggles section here needs exactly that list.
	// Re-deriving it would mean a second `listServerCatalog()` walk for an
	// identical answer.
	//
	// `prefs` does NOT: the layout ships them without the two free-text fields
	// (`LayoutPreferences` — it reloads on every turn, and they can run long),
	// and this is the page that edits those.
	const { featureCategories } = await parent();
	if (!locals.user) error(401, 'Authentication required');
	const prefs = getUserPreferences(locals.user.id);
	if (!prefs) error(404, 'User not found');
	return { prefs, featureCategories };
};
