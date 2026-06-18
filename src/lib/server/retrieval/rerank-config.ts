/**
 * Shared resolver for the optional cross-encoder rerank leg of hybrid retrieval.
 *
 * Reads the `[rerank]` block, resolves its endpoint, and hands back a
 * `RerankConfig` — or `undefined` when reranking isn't configured / the endpoint
 * no longer resolves, so the caller keeps the fused BM25/embedding order (never
 * an error). One memoized read (config.toml doesn't change at runtime), mirroring
 * `embeddings-config.ts`.
 */

import { loadRerankConfig, type LoadedRerankConfig } from '../endpoints/config';
import { getEndpoint } from '../endpoints/registry';
import type { RerankConfig } from './rerank';

let rerankConfigCache: { value: LoadedRerankConfig | null } | undefined;

function getRerankConfig(): LoadedRerankConfig | null {
	if (!rerankConfigCache) {
		let value: LoadedRerankConfig | null = null;
		try {
			value = loadRerankConfig();
		} catch (e) {
			// Reranking is an optional upgrade, so a missing/unreadable config file
			// or a malformed [rerank] block disables it (retrieval keeps the fused
			// order) rather than throwing into the calling tool. Memoized, so this
			// warns at most once.
			console.warn('[retrieval] could not load [rerank] config; reranking disabled:', e);
		}
		rerankConfigCache = { value };
	}
	return rerankConfigCache.value;
}

/** Test hook: clear the memoized rerank config so the next call re-reads. */
export function _resetRerankConfigCacheForTests(): void {
	rerankConfigCache = undefined;
}

/**
 * Resolve the `[rerank]` config into a usable `RerankConfig`, or undefined when
 * reranking isn't configured / the named endpoint no longer resolves. Undefined
 * makes the read keep the fused order.
 */
export function resolveRerankConfig(): RerankConfig | undefined {
	const cfg = getRerankConfig();
	if (!cfg) return undefined;
	const endpoint = getEndpoint(cfg.endpointId);
	if (!endpoint) return undefined;
	return {
		endpoint,
		modelId: cfg.modelId,
		timeoutSeconds: cfg.timeoutSeconds,
		topN: cfg.topN,
		quirk: cfg.quirk,
	};
}
