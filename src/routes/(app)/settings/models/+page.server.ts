import { listCustomModelsForUser } from '$lib/server/db/queries/custom-models';
import { listEndpoints } from '$lib/server/endpoints/registry';
import { listAllModelsWithErrors } from '$lib/server/endpoints/list-models';
import { ConfigError } from '$lib/server/endpoints/config';
import type { PageServerLoad } from './$types';

/**
 * SSR the available base models alongside the user's current custom models
 * so the form's picker has options on first paint without a follow-up
 * /api/models round trip.
 *
 * Goes through `listAllModelsWithErrors` — the same stale-while-revalidate
 * cache `/api/models` and the (app) layout use — rather than calling
 * `listUpstreamModels` per endpoint directly. Calling upstream directly meant
 * this page was the one caller that never hit the cache: it re-fetched every
 * endpoint's /v1/models on every visit, and since `request_timeout_seconds`
 * defaults to 120, a single hung endpoint stalled SSR for two minutes and then
 * silently rendered an empty picker (the per-endpoint catch swallowed it into
 * `models: []` with `modelsError: null`). The cached path also surfaces the
 * real per-endpoint error instead of discarding it.
 */
export const load: PageServerLoad = async ({ locals, parent }) => {
	// Wait for the (app) layout's auth check before deref'ing locals.user.
	// See /(app)/+page.server.ts for why.
	await parent();
	const customModels = listCustomModelsForUser(locals.user!.id);

	try {
		listEndpoints();
	} catch (e) {
		if (e instanceof ConfigError) {
			return { customModels, models: [], modelsError: e.message };
		}
		throw e;
	}

	const results = await listAllModelsWithErrors();
	const failed = results.filter((r) => r.error);
	return {
		customModels,
		models: results.flatMap((r) => r.models),
		// Name the endpoints that failed rather than reporting "no models" with no
		// explanation. Null when everything resolved.
		modelsError:
			failed.length > 0 ? failed.map((r) => `${r.endpointId}: ${r.error}`).join('; ') : null,
	};
};
