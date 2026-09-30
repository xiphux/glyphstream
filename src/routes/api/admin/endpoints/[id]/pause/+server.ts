import { error, json } from '@sveltejs/kit';
import { requireAdmin } from '$lib/server/auth/guard';
import { ConfigError, type LoadedEndpoint } from '$lib/server/endpoints/config';
import { pauseResourceGroup } from '$lib/server/endpoints/pause';
import { getEndpoint } from '$lib/server/endpoints/registry';
import { getEndpointsStatus } from '$lib/server/endpoints/status';
import type { RequestHandler } from './$types';

/**
 * Pause (`PUT`) or resume (`DELETE`) an endpoint's queue — the view's toggle.
 *
 * Acts on the endpoint's RESOURCE GROUP, because that is what the gate is: on a
 * shared GPU its members are one queue. Pausing lets whatever is generating
 * finish and grants nothing new; queued work keeps its place until resumed. The
 * pause is persisted, so it survives a restart of this process as well as the
 * backend's.
 *
 * PUT/DELETE on a sub-resource rather than a POST with a boolean body: both are
 * idempotent by nature, so a double-click cannot toggle the state back.
 * Returns the whole snapshot for the same reason Recheck does.
 */
export const PUT: RequestHandler = ({ locals, params, setHeaders }) => {
	requireAdmin(locals);
	setHeaders({ 'cache-control': 'no-store' });
	pauseResourceGroup(findEndpoint(params.id), true);
	return json(getEndpointsStatus());
};

export const DELETE: RequestHandler = ({ locals, params, setHeaders }) => {
	requireAdmin(locals);
	setHeaders({ 'cache-control': 'no-store' });
	pauseResourceGroup(findEndpoint(params.id), false);
	return json(getEndpointsStatus());
};

function findEndpoint(id: string): LoadedEndpoint {
	let endpoint;
	try {
		endpoint = getEndpoint(id);
	} catch (e) {
		// Same as Recheck: a config.toml that broke while the page was open is
		// reported by the poll's own snapshot, not as an opaque 500 here.
		if (e instanceof ConfigError) error(404, 'No such endpoint');
		throw e;
	}
	if (!endpoint) error(404, 'No such endpoint');
	return endpoint;
}
