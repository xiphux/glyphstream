/**
 * Shared resolver for the optional cross-encoder rerank leg of hybrid retrieval.
 *
 * Reads the `[rerank]` block, resolves its endpoint, and hands back a
 * `RerankConfig` — or `undefined` when reranking isn't configured / the endpoint
 * no longer resolves, so the caller keeps the fused BM25/embedding order (never
 * an error).
 *
 * Failure handling is the shared `createOptionalEndpointConfig` contract — see
 * that module for why a malformed block disables the leg instead of throwing.
 */

import { loadRerankConfig } from '../endpoints/config';
import { createOptionalEndpointConfig } from './optional-endpoint-config';
import type { RerankConfig } from './rerank';

const rerankConfig = createOptionalEndpointConfig({
	name: 'retrieval',
	block: '[rerank]',
	disabledNote: 'reranking disabled',
	load: loadRerankConfig,
	endpointIdOf: (cfg) => cfg.endpointId,
	build: (cfg, endpoint): RerankConfig => ({
		endpoint,
		modelId: cfg.modelId,
		timeoutSeconds: cfg.timeoutSeconds,
		topN: cfg.topN,
		quirk: cfg.quirk,
	}),
});

/**
 * Resolve the `[rerank]` config into a usable `RerankConfig`, or undefined when
 * reranking isn't configured / the named endpoint no longer resolves. Undefined
 * makes the read keep the fused order.
 */
export function resolveRerankConfig(): RerankConfig | undefined {
	return rerankConfig.resolve();
}

/** Test hook: clear the memoized rerank config so the next call re-reads. */
export function _resetRerankConfigCacheForTests(): void {
	rerankConfig.reset();
}
