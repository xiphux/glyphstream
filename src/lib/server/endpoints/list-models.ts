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
import { getEndpoint, listEndpoints } from './registry';
import type { ModelEntry } from '$lib/types/api';

interface CacheEntry {
	models: ModelEntry[];
	expiresAt: number;
	/** Last fetch's error, or null on success. Preserved across hits so
	 *  /api/models can show "endpoint X is down" without re-fetching. */
	error: string | null;
	/** Unix ms the fetch that produced this entry SETTLED, and how long it took.
	 *  The admin endpoint view reports both — "reachable" with no timestamp is
	 *  unfalsifiable, and on a failure the age is the whole story (a probe that
	 *  failed four seconds ago and one that failed at boot mean different
	 *  things). Note `models` may be older than this on a failure: the catch
	 *  deliberately preserves the last good list, so `fetchedAt` timestamps the
	 *  PROBE, not the models. */
	fetchedAt: number;
	durationMs: number;
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

async function getOrFetch(
	endpoint: ReturnType<typeof listEndpoints>[number],
): Promise<EndpointResult> {
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

function refreshInBackground(
	endpoint: ReturnType<typeof listEndpoints>[number],
): Promise<CacheEntry> {
	const pending = inFlight.get(endpoint.id);
	if (pending) return pending;

	const promise = (async () => {
		const startedAt = Date.now();
		try {
			const upstream = await listUpstreamModels(endpoint);
			const models = upstream.map((m) => normalizeUpstreamModel(endpoint, m));
			const settledAt = Date.now();
			const entry: CacheEntry = {
				models,
				expiresAt: settledAt + CACHE_TTL_MS,
				error: null,
				fetchedAt: settledAt,
				durationMs: settledAt - startedAt,
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
			const settledAt = Date.now();
			const entry: CacheEntry = {
				models: prior?.models ?? [],
				expiresAt: settledAt + CACHE_TTL_MS,
				error: msg,
				fetchedAt: settledAt,
				durationMs: settledAt - startedAt,
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

/**
 * What the cache currently believes about one endpoint, WITHOUT touching the
 * upstream or scheduling a refresh — not even the stale-while-revalidate one
 * `getOrFetch` kicks off. Null when nothing has ever been fetched for it.
 *
 * The read-only-ness is the point: the admin endpoint view polls every few
 * seconds, and a poll that refreshed would turn an open tab into a per-endpoint
 * `/v1/models` call every three seconds. Health there is deliberately whatever
 * ordinary traffic last observed, plus an explicit Recheck.
 */
export function getModelCacheEntry(endpointId: string): {
	models: ModelEntry[];
	error: string | null;
	fetchedAt: number;
	durationMs: number;
	expiresAt: number;
} | null {
	const entry = cache.get(endpointId);
	if (!entry) return null;
	return {
		models: entry.models,
		error: entry.error,
		fetchedAt: entry.fetchedAt,
		durationMs: entry.durationMs,
		expiresAt: entry.expiresAt,
	};
}

/**
 * Force one endpoint's model list to be re-fetched now, awaiting the result —
 * the Recheck button on the admin endpoint view.
 *
 * Goes through `refreshInBackground` rather than calling upstream directly, so
 * it shares the in-flight dedup (a Recheck landing during a background refresh
 * joins it instead of doubling the load) and writes the same cache entry every
 * other reader sees. A failure is not thrown: it lands on the entry as `error`,
 * which is exactly what the caller wants to render.
 */
export async function recheckEndpoint(endpointId: string): Promise<boolean> {
	let endpoint;
	try {
		endpoint = getEndpoint(endpointId);
	} catch (e) {
		// `getRegistry` deliberately does not memoize a failed load, so a
		// `config.toml` that broke while the page was open throws here rather than
		// on the GET — which catches ConfigError and renders it as a first-class
		// state. Letting it escape would answer the operator's click with an opaque
		// 500 in exactly the situation that state exists to explain. Reported as
		// "no such endpoint" instead; the poll's own snapshot carries the real
		// config error a moment later.
		if (e instanceof ConfigError) return false;
		throw e;
	}
	if (!endpoint) return false;
	await refreshInBackground(endpoint);
	return true;
}

/** Test/dev only: drop the cache so the next call re-fetches everything. */
export function resetModelCache(): void {
	cache.clear();
	inFlight.clear();
}
