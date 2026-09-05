import { requireAdmin } from '$lib/server/auth/guard';
import { listAllModelsWithErrors } from '$lib/server/endpoints/list-models';
import { getEndpointsStatus } from '$lib/server/endpoints/status';
import type { PageServerLoad } from './$types';

/**
 * Read-only endpoint health + activity view. Admin-only (requireAdmin throws
 * 403 for non-admins).
 *
 * SSRs a first snapshot so the page paints populated, then the client polls
 * `/api/admin/endpoints/status` for the live half. The initial load is the ONE
 * place that may pay an upstream round-trip: `listAllModelsWithErrors` warms
 * the shared model cache (respecting its stale-while-revalidate TTL and
 * in-flight dedup, so it usually returns from cache) which is what gives the
 * first paint a health state instead of a page of "unknown". Every subsequent
 * poll reads that cache without touching the upstream.
 *
 * Its result is deliberately discarded — the aggregation happens in
 * `getEndpointsStatus`, and this is called only for the warming side effect,
 * AFTER which the cache it filled is read.
 */
export const load: PageServerLoad = async ({ locals, parent }) => {
	// await parent() before deref'ing locals — see the (app) layout note in
	// CLAUDE.md. The payload here is small (no message content), so the
	// invalidation coupling that argues for `requireUserPage` on the chat route
	// costs nothing here.
	await parent();
	requireAdmin(locals);
	await listAllModelsWithErrors();
	return { status: getEndpointsStatus() };
};
