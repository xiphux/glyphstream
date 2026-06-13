import { redirect } from '@sveltejs/kit';
import { listConversations } from '$lib/server/db/queries/conversations';
import { listCustomModelsForUser } from '$lib/server/db/queries/custom-models';
import { countUsers } from '$lib/server/db/queries/users';
import { getUserPreferences } from '$lib/server/db/queries/user-preferences';
import { listEnabledSkillsForUser } from '$lib/server/db/queries/skills';
import { listConfiguredServerIds } from '$lib/server/db/queries/mcp-credentials';
import { listAllModels } from '$lib/server/endpoints/list-models';
import { getAllFeatureCategoryLabels } from '$lib/server/feature-categories';
import { awaitMcpReady } from '$lib/server/mcp/bootstrap';
import type { LayoutServerLoad } from './$types';

export const load: LayoutServerLoad = async ({ locals, url, depends }) => {
	if (!locals.user) {
		// Fresh-install bootstrap: route the operator to the first-run
		// wizard instead of a /login page they can't sign in at yet.
		if (countUsers() === 0) throw redirect(302, '/setup');
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
	//
	// Block once on MCP discovery so featureCategories carries the
	// `mcp:<id>` entries discovered at boot. Subsequent loads hit the
	// memoized ready promise immediately.
	await awaitMcpReady();
	// Tagged so a skill mutation on /settings/skills can `invalidate('app:skills')`
	// to refresh `enabledSkills` (the composer's /skill autocomplete) without a
	// full reload — the layout load otherwise only re-runs on navigation.
	depends('app:skills');
	// Same pattern for per-user MCP credentials: saving/removing one in
	// /settings/mcp `invalidate('app:mcp-credentials')`s so the composer's
	// capability list (featureCategories) reflects the newly-connected (or
	// removed) server right away. Kept separate from the page's own
	// `settings:mcp` key so frequent trust toggles / retries DON'T re-run this
	// layout — only the rare credential change does.
	depends('app:mcp-credentials');
	return {
		user: locals.user,
		conversations: listConversations(locals.user.id),
		prefs: getUserPreferences(locals.user.id),
		models: await listAllModels(),
		customModels: listCustomModelsForUser(locals.user.id),
		// Hide per-user MCP servers the user hasn't connected — an inert toggle
		// is confusing; they connect in Settings → MCP servers. Global servers
		// always show.
		featureCategories: getAllFeatureCategoryLabels({
			configuredPerUserServerIds: new Set(listConfiguredServerIds(locals.user.id)),
		}),
		// Enabled skills (name + description) for the composer's /skill-name
		// autocomplete. Catalog-index shape only — bodies stay server-side.
		enabledSkills: listEnabledSkillsForUser(locals.user.id).map((s) => ({
			id: s.id,
			name: s.name,
			description: s.description,
		})),
	};
};
