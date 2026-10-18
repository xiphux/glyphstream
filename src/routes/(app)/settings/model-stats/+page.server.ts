import { requireAdmin } from '#lib/server/auth/guard.js';
import { ConfigError } from '#lib/server/endpoints/config.js';
import { listEndpoints } from '#lib/server/endpoints/registry.js';
import { listAllModelsWithErrors } from '#lib/server/endpoints/list-models.js';
import {
	buildModelStatsReport,
	configuredModelRoles,
	parseModelStatsWindow,
} from '#lib/server/stats/model-stats-report.js';
import type { PageServerLoad } from './$types';

/**
 * Per-model usage and reception, for deciding which models earn their keep.
 * Admin-only. Read-only, so it needs no `/api/` twin: the window is a query
 * param and changing it is a navigation.
 *
 * The listings come from the shared model cache — the `(app)` layout has
 * already awaited the same aggregation, so this is a cache hit in practice.
 */
export const load: PageServerLoad = async ({ locals, parent, url }) => {
	// await parent() before deref'ing locals — see the (app) layout note in
	// CLAUDE.md. The payload is counters, not content, so the invalidation
	// coupling is cheap here.
	await parent();
	requireAdmin(locals);
	const listings = await listAllModelsWithErrors();
	return {
		report: buildModelStatsReport({
			window: parseModelStatsWindow(url.searchParams.get('window')),
			viewerUserId: locals.user.id,
			endpoints: configuredEndpoints(),
			listings,
			roles: configuredModelRoles(),
		}),
	};
};

/** A broken config.toml leaves the stats readable — every endpoint just shows
 *  as removed, which the endpoints page explains. */
function configuredEndpoints() {
	try {
		return listEndpoints();
	} catch (e) {
		if (e instanceof ConfigError) return [];
		throw e;
	}
}
