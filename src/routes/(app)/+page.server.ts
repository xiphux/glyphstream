import { error } from '@sveltejs/kit';
import { listCustomModelsForUser } from '$lib/server/db/queries/custom-models';
import { listEndpoints } from '$lib/server/endpoints/registry';
import { listUpstreamModels } from '$lib/server/endpoints/client';
import { ConfigError } from '$lib/server/endpoints/config';
import { normalizeUpstreamModel } from '$lib/server/endpoints/models';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals, parent }) => {
	// Wait for the (app) layout's auth check to either populate
	// locals.user or throw a redirect to /login. Without this, the page
	// load runs in parallel with the layout's load — and our `locals.user!`
	// non-null assertion below would TypeError-out before the redirect
	// has a chance to win, returning a 500 instead of a 302.
	await parent();

	let endpoints;
	try {
		endpoints = listEndpoints();
	} catch (e) {
		if (e instanceof ConfigError) {
			throw error(500, `Endpoint configuration is invalid: ${e.message}`);
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
	return {
		models: results.flat(),
		customModels: listCustomModelsForUser(locals.user!.id)
	};
};
