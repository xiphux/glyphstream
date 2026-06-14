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
import { embedAndRank, type RelevanceConfig } from './embed-rank';
import { fuseRankings } from './fusion';

/** Searchable text for one tool: name (lexical signal) + description (semantic). */
function toolDoc(entry: DeferredToolEntry): string {
	return `${entry.name}\n${entry.description}`;
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
			catalog.length > cfg.embedCap
				? bm25.slice(0, cfg.embedCap).map((sc) => sc.index)
				: docs.map((_, i) => i);
		const dense = await embedAndRank(
			query,
			candidateIdx.map((i) => docs[i]),
			cfg,
			signal,
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
