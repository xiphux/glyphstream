import { error, json } from '@sveltejs/kit';
import { requireAdmin } from '$lib/server/auth/guard';
import { recheckEndpoint } from '$lib/server/endpoints/list-models';
import { getEndpointsStatus } from '$lib/server/endpoints/status';
import type { RequestHandler } from './$types';

/**
 * Force one endpoint's reachability probe now — the view's Recheck button.
 *
 * POST rather than GET because it has an effect: it makes an upstream call and
 * overwrites the shared model cache every other reader sees. An unreachable
 * endpoint is NOT an error here — the failure is the answer, and it comes back
 * on the endpoint's `health` / `error` in the returned snapshot.
 *
 * Returns the whole snapshot rather than the one endpoint so the caller can
 * swap in a coherent picture; the polling client would otherwise have to merge
 * a single row into a payload that may have moved on underneath it.
 */
export const POST: RequestHandler = async ({ locals, params, setHeaders }) => {
	requireAdmin(locals);
	setHeaders({ 'cache-control': 'no-store' });
	if (!(await recheckEndpoint(params.id))) error(404, 'No such endpoint');
	return json(getEndpointsStatus());
};
