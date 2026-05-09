import { error } from '@sveltejs/kit';
import { listEndpoints, formatModelId } from '$lib/server/endpoints/registry';
import { listUpstreamModels } from '$lib/server/endpoints/client';
import { ConfigError } from '$lib/server/endpoints/config';
import type { ModelEntry, ModelKind } from '$lib/types/api';
import type { PageServerLoad } from './$types';

const VALID_KINDS: readonly ModelKind[] = ['chat', 'embedding', 'image', 'video'];

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
				return upstream.map((m): ModelEntry => {
					const kindKnown =
						typeof m.kind === 'string' && (VALID_KINDS as readonly string[]).includes(m.kind);
					return {
						id: formatModelId(endpoint.id, m.id),
						endpointId: endpoint.id,
						upstreamId: m.id,
						displayName: m.display_name && m.display_name.length > 0 ? m.display_name : m.id,
						kind: kindKnown ? (m.kind as ModelKind) : 'chat',
						kindKnown
					};
				});
			} catch {
				return [];
			}
		})
	);
	return { models: results.flat() };
};
