/**
 * Shared resolver for the optional embedding (semantic) leg of hybrid retrieval.
 *
 * Both `fetch_url` (document relevance) and `search_tools` (deferred-tool search)
 * need the same thing: read the `[embeddings]` block, resolve its endpoint, and
 * hand back a `RelevanceConfig` — or `undefined` when embeddings aren't
 * configured / the endpoint no longer resolves, so the caller degrades to
 * BM25-only (never an error). One memoized read backs both, so there's a single
 * cache with a single test reset rather than a per-tool clone.
 *
 * Failure handling is the shared `createOptionalEndpointConfig` contract — see
 * that module for why a malformed block disables the leg instead of throwing.
 */

import { loadEmbeddingsConfig } from '../endpoints/config';
import { createOptionalEndpointConfig } from './optional-endpoint-config';
import type { RelevanceConfig } from './embed-rank';

const embeddingsConfig = createOptionalEndpointConfig({
	name: 'retrieval',
	block: '[embeddings]',
	disabledNote: 'embeddings disabled',
	load: loadEmbeddingsConfig,
	endpointIdOf: (cfg) => cfg.endpointId,
	build: (cfg, endpoint): RelevanceConfig => ({
		endpoint,
		modelId: cfg.modelId,
		timeoutSeconds: cfg.timeoutSeconds,
		queryPrefix: cfg.queryPrefix,
		documentPrefix: cfg.documentPrefix,
		maxInputTokens: cfg.maxInputTokens,
		gallerySearchMinSimilarity: cfg.gallerySearchMinSimilarity,
	}),
});

/**
 * Resolve the `[embeddings]` config into a usable `RelevanceConfig`, or undefined
 * when embeddings aren't configured / the named endpoint no longer resolves.
 * Undefined makes the dense leg degrade to BM25-only.
 */
export function resolveRelevanceConfig(): RelevanceConfig | undefined {
	return embeddingsConfig.resolve();
}

/** Test hook: clear the memoized embeddings config so the next call re-reads. */
export function _resetEmbeddingsConfigCacheForTests(): void {
	embeddingsConfig.reset();
}
