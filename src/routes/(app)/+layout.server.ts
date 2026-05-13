import { redirect } from '@sveltejs/kit';
import { listConversations } from '$lib/server/db/queries/conversations';
import { getUserPreferences } from '$lib/server/db/queries/user-preferences';
import type { LayoutServerLoad } from './$types';

export const load: LayoutServerLoad = ({ locals, url }) => {
	if (!locals.user) {
		throw redirect(302, `/login?from=${encodeURIComponent(url.pathname)}`);
	}
	// Load prefs at the layout level so every (app) page has them on
	// first paint — the composer's enter-key handler needs to branch on
	// `prefs.enterBehavior` synchronously without waiting on a client-
	// side fetch (which would race the first keystroke after page load).
	return {
		user: locals.user,
		conversations: listConversations(locals.user.id),
		prefs: getUserPreferences(locals.user.id)
	};
};
