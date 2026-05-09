import { json, error } from '@sveltejs/kit';
import { listEndpoints, formatModelId } from '$lib/server/endpoints/registry';
import { listUpstreamModels, UpstreamError } from '$lib/server/endpoints/client';
import { ConfigError } from '$lib/server/endpoints/config';
import type { ModelEntry, ModelKind, UpstreamModel } from '$lib/types/api';
import type { RequestHandler } from './$types';

const VALID_KINDS: readonly ModelKind[] = ['chat', 'embedding', 'image', 'video'];

interface CacheEntry {
	models: ModelEntry[];
	expiresAt: number;
}

const CACHE_TTL_MS = 60_000;
const cache = new Map<string, CacheEntry>();

export const GET: RequestHandler = async () => {
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
				const models = upstream.map((m) => normalizeModel(endpoint.id, m));
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

function normalizeModel(endpointId: string, m: UpstreamModel): ModelEntry {
	const upstreamId = m.id;
	const kindRaw = m.kind;
	const kindKnown = typeof kindRaw === 'string' && (VALID_KINDS as readonly string[]).includes(kindRaw);
	return {
		id: formatModelId(endpointId, upstreamId),
		endpointId,
		upstreamId,
		displayName: m.display_name && m.display_name.length > 0 ? m.display_name : upstreamId,
		kind: kindKnown ? (kindRaw as ModelKind) : 'chat',
		kindKnown
	};
}
