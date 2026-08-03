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
import { filterInFlight } from '$lib/server/streaming/in-flight';
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
	// `settings:mcp` key so frequent trust toggles / retries don't re-serialize
	// this layout's payload to the client — only the rare credential change does.
	// (The load body still re-runs whenever a page that `await parent()`s is
	// invalidated; the key controls what's sent, not what executes.)
	depends('app:mcp-credentials');
	// Tagged so a client that resumes from background (visibilitychange /
	// focus / pageshow in the (app) layout) can `invalidate('app:conversations')`
	// to pull in conversations created on *other* clients since it last loaded.
	// Targeted key rather than invalidateAll() so the chat page's own load +
	// in-flight stream stay untouched — only this layout load re-runs. (That
	// re-runs the whole load body, not just listConversations, but it's cheap:
	// cached models + local SQLite.)
	depends('app:conversations');
	// Preferences that live on `prefs` and are mutated from surfaces outside
	// /settings/preferences — favorite models (the picker's star, the sidebar's
	// drag-reorder) and saved model sets. Those write through
	// PATCH /api/user/preferences and then need `prefs` re-read; a separate key
	// keeps that from re-serializing the open page's payload.
	//
	// Not a blanket "no page re-runs". The sidebar's favorites drag lives in this
	// layout, so it's mounted on every (app) page, and any page that `await
	// parent()`s does re-run its load — per the `uses.parent` note in CLAUDE.md.
	// Reordering favorites while on /gallery re-runs that load. Those payloads are
	// small; what the key protects is `chat/[id]`, which guards with
	// `requireUserPage` instead of `await parent()` and so stays untouched — and
	// that's the one whose payload is the entire conversation.
	depends('app:prefs');
	const conversations = listConversations(locals.user.id);
	return {
		user: locals.user,
		conversations,
		// Which of those have a generation running server-side right now. Seeds
		// the sidebar's generating dot at layout mount so a reload / cold PWA
		// launch into some *other* thread still shows the video left cooking
		// (the client-side flag is in-memory and doesn't survive the reload).
		// Free: an in-memory registry lookup per row, no extra query — and
		// scoped by construction, since it can only answer for rows this user
		// already owns.
		generatingIds: filterInFlight(conversations.map((c) => c.id)),
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
