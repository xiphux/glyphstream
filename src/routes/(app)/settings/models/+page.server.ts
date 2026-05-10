import { listCustomModelsForUser } from '$lib/server/db/queries/custom-models';
import { listEndpoints } from '$lib/server/endpoints/registry';
import { listUpstreamModels } from '$lib/server/endpoints/client';
import { ConfigError } from '$lib/server/endpoints/config';
import { normalizeUpstreamModel } from '$lib/server/endpoints/models';
import type { PageServerLoad } from './$types';

/**
 * SSR the available base models alongside the user's current custom models
 * so the form's picker has options on first paint without a follow-up
 * /api/models round trip.
 */
export const load: PageServerLoad = async ({ locals, parent }) => {
	// Wait for the (app) layout's auth check before deref'ing locals.user.
	// See /(app)/+page.server.ts for why.
	await parent();
	const customModels = listCustomModelsForUser(locals.user!.id);

	let endpoints;
	try {
		endpoints = listEndpoints();
	} catch (e) {
		if (e instanceof ConfigError) {
			return { customModels, models: [], modelsError: e.message };
		}
		throw e;
	}

	const results = await Promise.all(
		endpoints.map(async (endpoint) => {
			try {
				const upstream = await listUpstreamModels(endpoint);
				return upstream.map((m) => normalizeUpstreamModel(endpoint.id, m));
			} catch {
				return [];
			}
		})
	);
	return { customModels, models: results.flat(), modelsError: null };
};
