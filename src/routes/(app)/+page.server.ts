import { error } from '@sveltejs/kit';
import { listEndpoints } from '$lib/server/endpoints/registry';
import { listUpstreamModels } from '$lib/server/endpoints/client';
import { ConfigError } from '$lib/server/endpoints/config';
import { normalizeUpstreamModel } from '$lib/server/endpoints/models';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async () => {
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
	return { models: results.flat() };
};
