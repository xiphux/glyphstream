import { error } from '@sveltejs/kit';
import { listMemoriesForUser, listDeletedMemoriesForUser } from '$lib/server/db/queries/memories';
import { getConversationOverviewMeta } from '$lib/server/db/queries/users';
import type { PageServerLoad } from './$types';

/**
 * SSR the user's saved memories so the list paints with real data on
 * first load. `await parent()` first per the (app) page convention —
 * without it, the locals.user!.id deref races the layout's
 * redirect-on-no-auth and surfaces as a 500 instead of a 302.
 */
export const load: PageServerLoad = async ({ locals, parent, depends }) => {
	await parent();
	if (!locals.user) throw error(401, 'Authentication required');
	// Tagged so the page can `invalidate('settings:memories')` after a
	// delete to re-run just this load — without re-running the (app)
	// layout, which would re-send conversations + models + prefs + custom
	// models + feature categories (~15-20 KB the memories change doesn't
	// touch).
	depends('settings:memories');
	const memories = listMemoriesForUser(locals.user.id);
	// Dreaming-tombstoned rows for the "Recently tidied" recovery list. Empty
	// unless a [memory_model] is configured (only the dreaming pass soft-deletes).
	const deletedMemories = listDeletedMemoriesForUser(locals.user.id);
	// The conversation-topics overview (view-only) — the map injected into the
	// persona prompt. Null until the background pass has built one.
	const conversationOverview = getConversationOverviewMeta(locals.user.id);
	return { memories, deletedMemories, conversationOverview };
};
