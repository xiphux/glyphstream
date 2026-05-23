import { redirect } from '@sveltejs/kit';
import { listConversations } from '$lib/server/db/queries/conversations';
import { listCustomModelsForUser } from '$lib/server/db/queries/custom-models';
import { getUserPreferences } from '$lib/server/db/queries/user-preferences';
import { listAllModels } from '$lib/server/endpoints/list-models';
import type { LayoutServerLoad } from './$types';

export const load: LayoutServerLoad = async ({ locals, url }) => {
	if (!locals.user) {
		throw redirect(302, `/login?from=${encodeURIComponent(url.pathname)}`);
	}
	// Load prefs at the layout level so every (app) page has them on
	// first paint — the composer's enter-key handler needs to branch on
	// `prefs.enterBehavior` synchronously without waiting on a client-
	// side fetch (which would race the first keystroke after page load).
	//
	// Models + customModels also live here so the sidebar's "Favorites"
	// section can resolve display labels for the user's favorited model
	// ids without each (app) page having to re-fetch them. The home and
	// chat pages then read them via `await parent()` instead of running
	// their own copy of the same fetch loop.
	return {
		user: locals.user,
		conversations: listConversations(locals.user.id),
		prefs: getUserPreferences(locals.user.id),
		models: await listAllModels(),
		customModels: listCustomModelsForUser(locals.user.id)
	};
};
