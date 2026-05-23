/**
 * Shared "fetch all upstream models from every configured endpoint" helper.
 *
 * The (app) layout, the new-chat page, the chat page, and /api/models all
 * need the same aggregated list. Centralizing the fetch+normalize loop
 * gives us one place to attach a cache so back-to-back (app) navigations
 * don't each pay the upstream round-trip.
 *
 * Per-endpoint failures degrade silently to `[]` for that endpoint — a
 * single misconfigured upstream shouldn't blank the whole picker. The
 * error message is preserved on the cache entry so `/api/models` can
 * surface it to the client without re-running the failed fetch.
 *
 * Cache strategy: stale-while-revalidate. A cache hit returns immediately
 * even past its TTL; expiry kicks off a background refresh that updates
 * the entry without blocking the request. Only the cold case (no prior
 * data at all) actually waits on the upstream. This eliminates the
 * "every 60s one nav blocks on /v1/models" hang without changing
 * eventual-consistency semantics — a stale entry is at most TTL old in
 * steady-state, and the in-flight dedup prevents a thundering herd
 * across concurrent requests during the refresh.
 */

import { ConfigError } from './config';
import { listUpstreamModels, UpstreamError } from './client';
import { normalizeUpstreamModel } from './models';
import { listEndpoints } from './registry';
import type { ModelEntry } from '$lib/types/api';

interface CacheEntry {
	models: ModelEntry[];
	expiresAt: number;
	/** Last fetch's error, or null on success. Preserved across hits so
	 *  /api/models can show "endpoint X is down" without re-fetching. */
	error: string | null;
}
const CACHE_TTL_MS = 60_000;
const cache = new Map<string, CacheEntry>();
const inFlight = new Map<string, Promise<CacheEntry>>();

interface EndpointResult {
	endpointId: string;
	models: ModelEntry[];
	error: string | null;
}

/**
 * Returns the aggregated, normalized model list across every configured
 * endpoint. Returns `[]` (not throws) when the endpoint config is invalid
 * — callers that need to surface that distinction should call
 * `listEndpoints()` directly.
 */
export async function listAllModels(): Promise<ModelEntry[]> {
	const results = await listAllModelsWithErrors();
	return results.flatMap((r) => r.models);
}

/**
 * Same fetch path as `listAllModels`, but preserves per-endpoint errors
 * so /api/models can return them alongside the model list. Returns `[]`
 * on a ConfigError so the caller can decide whether to throw 500 or
 * silently degrade.
 */
export async function listAllModelsWithErrors(): Promise<EndpointResult[]> {
	let endpoints;
	try {
		endpoints = listEndpoints();
	} catch (e) {
		if (e instanceof ConfigError) return [];
		throw e;
	}

	return Promise.all(endpoints.map((endpoint) => getOrFetch(endpoint)));
}

async function getOrFetch(endpoint: ReturnType<typeof listEndpoints>[number]): Promise<EndpointResult> {
	const now = Date.now();
	const cached = cache.get(endpoint.id);

	if (cached) {
		// Past TTL: kick off a background refresh (deduped) but return the
		// stale entry immediately. The refresh updates `cache` for the next
		// caller. We deliberately don't await it.
		if (cached.expiresAt <= now) {
			void refreshInBackground(endpoint);
		}
		return { endpointId: endpoint.id, models: cached.models, error: cached.error };
	}

	// Cold cache: must wait. Dedup so a burst of concurrent requests during
	// startup doesn't fan out one upstream call per request per endpoint.
	const entry = await refreshInBackground(endpoint);
	return { endpointId: endpoint.id, models: entry.models, error: entry.error };
}

function refreshInBackground(endpoint: ReturnType<typeof listEndpoints>[number]): Promise<CacheEntry> {
	const pending = inFlight.get(endpoint.id);
	if (pending) return pending;

	const promise = (async () => {
		try {
			const upstream = await listUpstreamModels(endpoint);
			const models = upstream.map((m) => normalizeUpstreamModel(endpoint, m));
			const entry: CacheEntry = {
				models,
				expiresAt: Date.now() + CACHE_TTL_MS,
				error: null
			};
			cache.set(endpoint.id, entry);
			return entry;
		} catch (e) {
			// Preserve any prior models on a transient failure — the
			// caller already saw them, so blanking now would be a UX
			// regression. We do bump expiresAt forward so the next
			// request doesn't immediately re-attempt; backoff is via
			// the normal TTL.
			const msg =
				e instanceof UpstreamError
					? `${e.message}${e.status ? ` (status ${e.status})` : ''}`
					: e instanceof Error
						? e.message
						: String(e);
			const prior = cache.get(endpoint.id);
			const entry: CacheEntry = {
				models: prior?.models ?? [],
				expiresAt: Date.now() + CACHE_TTL_MS,
				error: msg
			};
			cache.set(endpoint.id, entry);
			return entry;
		} finally {
			inFlight.delete(endpoint.id);
		}
	})();

	inFlight.set(endpoint.id, promise);
	return promise;
}

/** Test/dev only: drop the cache so the next call re-fetches everything. */
export function resetModelCache(): void {
	cache.clear();
	inFlight.clear();
}
