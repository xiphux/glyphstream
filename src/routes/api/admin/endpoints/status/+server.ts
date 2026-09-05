import { json } from '@sveltejs/kit';
import { requireAdmin } from '$lib/server/auth/guard';
import { getEndpointsStatus } from '$lib/server/endpoints/status';
import type { RequestHandler } from './$types';

/**
 * Live endpoint diagnostics for the admin view, polled every few seconds while
 * that page is open.
 *
 * Reads in-process state only — the endpoint registry, the concurrency gate,
 * and the model-list cache — so a poll costs no upstream round-trip no matter
 * how many endpoints are configured. Reachability is therefore as fresh as
 * ordinary traffic last made it; `POST /api/admin/endpoints/:id/recheck` is the
 * way to force a probe.
 */
export const GET: RequestHandler = ({ locals, setHeaders }) => {
	requireAdmin(locals);
	// A poll response that a browser or proxy may reuse is worse than no poll.
	setHeaders({ 'cache-control': 'no-store' });
	return json(getEndpointsStatus());
};
