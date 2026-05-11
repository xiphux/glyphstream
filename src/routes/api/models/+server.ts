import { json, error } from '@sveltejs/kit';
import { listEndpoints } from '$lib/server/endpoints/registry';
import { listUpstreamModels, UpstreamError } from '$lib/server/endpoints/client';
import { ConfigError } from '$lib/server/endpoints/config';
import { normalizeUpstreamModel } from '$lib/server/endpoints/models';
import type { ModelEntry } from '$lib/types/api';
import type { RequestHandler } from './$types';

interface CacheEntry {
	models: ModelEntry[];
	expiresAt: number;
}

const CACHE_TTL_MS = 60_000;
const cache = new Map<string, CacheEntry>();

export const GET: RequestHandler = async ({ locals }) => {
	if (!locals.user) {
		throw error(401, 'Authentication required');
	}

	let endpoints;
	try {
		endpoints = listEndpoints();
	} catch (e) {
		if (e instanceof ConfigError) {
			throw error(500, `Endpoint configuration is invalid: ${e.message}`);
		}
		throw e;
	}

	const now = Date.now();
	const results = await Promise.all(
		endpoints.map(async (endpoint) => {
			const cached = cache.get(endpoint.id);
			if (cached && cached.expiresAt > now) {
				return { endpointId: endpoint.id, models: cached.models, error: null };
			}

			try {
				const upstream = await listUpstreamModels(endpoint);
				const models = upstream.map((m) => normalizeUpstreamModel(endpoint, m));
				cache.set(endpoint.id, { models, expiresAt: now + CACHE_TTL_MS });
				return { endpointId: endpoint.id, models, error: null };
			} catch (e) {
				const msg =
					e instanceof UpstreamError
						? `${e.message}${e.status ? ` (status ${e.status})` : ''}`
						: e instanceof Error
							? e.message
							: String(e);
				return { endpointId: endpoint.id, models: [], error: msg };
			}
		})
	);

	const allModels = results.flatMap((r) => r.models);
	const errors = results.filter((r) => r.error).map((r) => ({ endpointId: r.endpointId, error: r.error }));

	return json({
		object: 'list',
		data: allModels,
		// Per-endpoint errors surface here so a single broken upstream doesn't
		// hide the others' models. Frontend can show a banner.
		endpoint_errors: errors
	});
};

