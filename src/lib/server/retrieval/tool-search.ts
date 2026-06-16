/**
 * Hybrid ranker for the `search_tools` built-in: score a catalog of deferred
 * tools against a query and return them best-first.
 *
 *   - BM25 (always) — lexical precision. A tool's namespaced name carries strong
 *     signal (`mcp__github__create_issue`); `tokenize` splits on `_` so the name
 *     parts and the description are matched together.
 *   - Embedding cosine (when an embeddings model is configured) — semantic recall
 *     so "file a bug" finds `create_issue`. Fused with BM25 via RRF.
 *
 * Failure of the dense leg degrades to BM25-only (a search must never error).
 * Cost is bounded the same way `select.ts` bounds it: BM25-prefilter to EMBED_CAP
 * candidates before embedding.
 *
 * "No match" semantics differ by leg, deliberately:
 *   - BM25-only: only tools with a positive lexical score are returned, so a
 *     query that shares no terms with any tool returns nothing (the model learns
 *     to rephrase) rather than arbitrary tools.
 *   - Hybrid: every embedded candidate has a cosine score, so the fused ranking
 *     always surfaces the top semantic matches; the caller takes the top K and
 *     the model decides.
 */

import type { DeferredToolEntry } from '../tools/types';
import { bm25Rank, type ScoredChunk } from './bm25';
import { embedAndRankCached, EMBED_CAP, type RelevanceConfig } from './embed-rank';
import { fuseRankings } from './fusion';
import type { Vec } from './vector';

/** Searchable text for one tool: name (lexical signal) + description (semantic). */
function toolDoc(entry: DeferredToolEntry): string {
	return `${entry.name}\n${entry.description}`;
}

/**
 * Process-level cache of tool-document embeddings, shared across every
 * `search_tools` call. The deferred catalog is essentially static per process
 * (tool name + description), so without this the entire catalog is re-embedded
 * on every search — and the model is told to re-search on weak results, so it
 * compounds. Keyed by `(model, prepared-input)` inside embedAndRankCached, so a
 * model swap or a changed description simply misses and re-embeds. Bounded: a
 * tool description that churns leaves a stale entry, so clear wholesale past a
 * generous cap (catalogs are small; the cache just re-warms). Safe as module
 * state given the single-Node-process deployment.
 */
const TOOL_DOC_VEC_CACHE_MAX = 4096;
const toolDocVecCache = new Map<string, Vec>();

/** Drop all cached tool-document vectors. For tests (cache is module state that
 *  would otherwise leak across cases); also a manual invalidation hook. */
export function clearToolDocVecCache(): void {
	toolDocVecCache.clear();
}

/**
 * Rank `catalog` against `query`, best-first. Returns catalog entries (a subset
 * in BM25-only mode — only lexical matches; the full ranked set in hybrid mode).
 * The caller takes the top K.
 */
export async function searchToolCatalog(
	query: string,
	catalog: DeferredToolEntry[],
	cfg: RelevanceConfig | undefined,
	signal: AbortSignal,
): Promise<DeferredToolEntry[]> {
	if (catalog.length === 0) return [];

	const docs = catalog.map(toolDoc);
	const bm25 = bm25Rank(query, docs);
	// Only positive-score entries are real lexical matches. bm25Rank returns ALL
	// docs (zero-score ones in index order), so we must NOT feed those zero ranks
	// into the fusion — they'd impose a meaningless lexical ordering that can
	// outweigh a genuine semantic win. The fusion and the BM25-only result both
	// use hits only; the broad candidate set for embedding still comes from the
	// full ranking (we WANT to embed lexically-unrelated tools — that's the point
	// of semantic recall).
	const bm25Hits = bm25.filter((sc) => sc.score > 0);
	const hitIdx = new Set(bm25Hits.map((sc) => sc.index));

	if (cfg) {
		// Bound embedding cost: prefilter to the top BM25 candidates on a large
		// catalog. Keep the catalog-index mapping so dense fuses in catalog space.
		const candidateIdx =
			catalog.length > EMBED_CAP
				? bm25.slice(0, EMBED_CAP).map((sc) => sc.index)
				: docs.map((_, i) => i);
		if (toolDocVecCache.size > TOOL_DOC_VEC_CACHE_MAX) toolDocVecCache.clear();
		const dense = await embedAndRankCached(
			query,
			candidateIdx.map((i) => docs[i]),
			cfg,
			signal,
			toolDocVecCache,
		);
		if (dense) {
			// Remap dense (candidate-subset index) → catalog-index space, then fuse.
			const denseCatalog: ScoredChunk[] = dense.map((sc) => ({
				index: candidateIdx[sc.index],
				score: sc.score,
			}));
			const fused = fuseRankings([bm25Hits, denseCatalog]);
			// A match is anything with lexical overlap OR an embedded candidate.
			const matched = new Set<number>([...hitIdx, ...candidateIdx]);
			return fused.filter((sc) => matched.has(sc.index)).map((sc) => catalog[sc.index]);
		}
	}

	// BM25-only (no embeddings configured, or dense leg failed): lexical matches
	// only, ranked. Empty when nothing overlapped.
	return bm25Hits.map((sc) => catalog[sc.index]);
}
