import { listCustomModelsForUser } from '#lib/server/db/queries/custom-models.js';
import { listEndpoints } from '#lib/server/endpoints/registry.js';
import {
	endpointErrorForViewer,
	listAllModelsWithErrors,
} from '#lib/server/endpoints/list-models.js';
import { ConfigError } from '#lib/server/endpoints/config.js';
import type { PageServerLoad } from './$types';

/**
 * SSR the available base models alongside the user's current custom models
 * so the form's picker has options on first paint without a follow-up
 * /api/models round trip.
 *
 * Goes through `listAllModelsWithErrors` — the same stale-while-revalidate
 * cache `/api/models` and the (app) layout use — rather than calling
 * `listUpstreamModels` per endpoint directly. A direct call bypasses the cache
 * and re-fetches every endpoint's /v1/models on every visit; since
 * `request_timeout_seconds` defaults to 120, a single hung endpoint would stall
 * SSR for two minutes and then render an empty picker with no error. The
 * cached path also surfaces the real per-endpoint error.
 */
export const load: PageServerLoad = async ({ locals, parent }) => {
	// Wait for the (app) layout's auth check before deref'ing locals.user.
	// See /(app)/+page.server.ts for why.
	await parent();
	const customModels = listCustomModelsForUser(locals.user!.id);
	const role = locals.user!.role;

	try {
		listEndpoints();
	} catch (e) {
		if (e instanceof ConfigError) {
			return {
				customModels,
				models: [],
				modelsError: endpointErrorForViewer(role, 'config', e.message),
			};
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
			failed.length > 0
				? failed
						.map((r) => `${r.endpointId}: ${endpointErrorForViewer(role, 'listing', r.error!)}`)
						.join('; ')
				: null,
	};
};
