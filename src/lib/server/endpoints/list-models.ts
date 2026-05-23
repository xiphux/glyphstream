/**
 * Shared "fetch all upstream models from every configured endpoint" helper.
 *
 * The (app) layout, the new-chat page, and the chat page all need the same
 * aggregated list — for the model picker, the sidebar favorites, and the
 * per-turn picker respectively. Inlining the fetch+normalize loop three
 * times made it easy for them to drift; centralizing also gives us one
 * place to attach a short-TTL cache so back-to-back (app) navigations don't
 * each pay the upstream round-trip.
 *
 * Per-endpoint failures degrade silently to `[]` for that endpoint — a
 * single misconfigured upstream shouldn't blank the whole picker.
 */

import { ConfigError } from './config';
import { listUpstreamModels } from './client';
import { normalizeUpstreamModel } from './models';
import { listEndpoints } from './registry';
import type { ModelEntry } from '$lib/types/api';

// Per-endpoint cache; matches the 60s TTL the standalone /api/models route
// uses. Map key is the endpoint id; expiresAt is unix-ms.
interface CacheEntry {
	models: ModelEntry[];
	expiresAt: number;
}
const CACHE_TTL_MS = 60_000;
const cache = new Map<string, CacheEntry>();

/**
 * Returns the aggregated, normalized model list across every configured
 * endpoint. Returns `[]` (not throws) when the endpoint config is invalid
 * — callers that need to surface that distinction should call
 * `listEndpoints()` directly. A typical caller treats "no models" the same
 * regardless of cause.
 */
export async function listAllModels(): Promise<ModelEntry[]> {
	let endpoints;
	try {
		endpoints = listEndpoints();
	} catch (e) {
		if (e instanceof ConfigError) return [];
		throw e;
	}

	const now = Date.now();
	const results = await Promise.all(
		endpoints.map(async (endpoint) => {
			const cached = cache.get(endpoint.id);
			if (cached && cached.expiresAt > now) return cached.models;
			try {
				const upstream = await listUpstreamModels(endpoint);
				const models = upstream.map((m) => normalizeUpstreamModel(endpoint, m));
				cache.set(endpoint.id, { models, expiresAt: now + CACHE_TTL_MS });
				return models;
			} catch {
				return [];
			}
		})
	);
	return results.flat();
}
