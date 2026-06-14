/**
 * Shared resolver for the optional embedding (semantic) leg of hybrid retrieval.
 *
 * Both `fetch_url` (document relevance) and `search_tools` (deferred-tool search)
 * need the same thing: read the `[embeddings]` block, resolve its endpoint, and
 * hand back a `RelevanceConfig` — or `undefined` when embeddings aren't
 * configured / the endpoint no longer resolves, so the caller degrades to
 * BM25-only (never an error). One memoized read backs both (config.toml doesn't
 * change at runtime), so there's a single cache with a single test reset rather
 * than a per-tool clone.
 */

import { loadEmbeddingsConfig, type LoadedEmbeddingsConfig } from '../endpoints/config';
import { getEndpoint } from '../endpoints/registry';
import { EMBED_CAP } from './select';
import type { RelevanceConfig } from './embed-rank';

let embeddingsConfigCache: { value: LoadedEmbeddingsConfig | null } | undefined;

function getEmbeddingsConfig(): LoadedEmbeddingsConfig | null {
	if (!embeddingsConfigCache) embeddingsConfigCache = { value: loadEmbeddingsConfig() };
	return embeddingsConfigCache.value;
}

/** Test hook: clear the memoized embeddings config so the next call re-reads. */
export function _resetEmbeddingsConfigCacheForTests(): void {
	embeddingsConfigCache = undefined;
}

/**
 * Resolve the `[embeddings]` config into a usable `RelevanceConfig`, or undefined
 * when embeddings aren't configured / the named endpoint no longer resolves.
 * Undefined makes the dense leg degrade to BM25-only.
 */
export function resolveRelevanceConfig(): RelevanceConfig | undefined {
	const cfg = getEmbeddingsConfig();
	if (!cfg) return undefined;
	const endpoint = getEndpoint(cfg.endpointId);
	if (!endpoint) return undefined;
	return {
		endpoint,
		modelId: cfg.modelId,
		timeoutSeconds: cfg.timeoutSeconds,
		embedCap: EMBED_CAP,
		queryPrefix: cfg.queryPrefix,
		documentPrefix: cfg.documentPrefix,
		maxInputTokens: cfg.maxInputTokens,
	};
}
