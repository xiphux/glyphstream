/**
 * Cross-encoder reranking — the biggest deferred quality jump after hybrid
 * retrieval. Given the query and the top fused candidates, a purpose-trained
 * reranker (e.g. bge-reranker-v2-m3) scores each candidate's relevance jointly
 * with the query, which a bag-of-features retriever (BM25 ⊕ embedding cosine)
 * can't. It reorders the candidate list; everything downstream (pack-to-budget,
 * document-order render) is unchanged.
 *
 * Same degradation contract as the dense leg: ANY failure (endpoint down,
 * timeout, malformed response, no usable rows) returns null so the caller keeps
 * the fused order. Reranking must never turn a fetch into an error — it's a
 * reorder-if-we-can, otherwise pass-through.
 *
 * Cost is bounded by the caller: it passes at most `cfg.topN` candidates, which
 * are themselves the top of a set already capped at EMBED_CAP. The reranker is
 * one extra request per over-budget fetch_url with a `find`.
 */

import type { LoadedEndpoint } from '../endpoints/config';
import { rerank, type RerankQuirk } from '../endpoints/client';
import { composeSignals } from '../util/abort';
import type { ScoredChunk } from './bm25';

export interface RerankConfig {
	endpoint: LoadedEndpoint;
	modelId: string;
	timeoutSeconds: number;
	/** How many of the top fused candidates to rerank. */
	topN: number;
	/** Wire-shape variant; undefined = the Cohere/Jina default. */
	quirk: RerankQuirk | undefined;
}

/**
 * Rerank `docs` (already the top fused candidates, in fused order) against the
 * query. Returns ScoredChunk indices relative to `docs`, ordered by descending
 * reranker score, or null on ANY failure (so the caller keeps the fused order).
 *
 * The reranker may return fewer rows than it was given (it can drop low-scoring
 * candidates, and we drop unparseable rows); any candidate the reranker doesn't
 * place is simply absent from the result. The caller is responsible for keeping
 * those tail candidates in their original order behind the reranked ones.
 */
export async function rerankDocs(
	query: string,
	docs: string[],
	cfg: RerankConfig,
	signal: AbortSignal,
): Promise<ScoredChunk[] | null> {
	if (docs.length === 0) return null;
	try {
		const sig = composeSignals(signal, AbortSignal.timeout(cfg.timeoutSeconds * 1000));
		// `docs` is already the cost-capped candidate set — the caller (applyRerank)
		// sliced it to cfg.topN before calling. So the wire `top_n` is docs.length
		// ("score and return all of these"), NOT cfg.topN; the ceiling is enforced
		// by the slice, not by asking the backend to drop rows.
		const results = await rerank(
			cfg.endpoint,
			{ model: cfg.modelId, query, documents: docs, topN: docs.length },
			cfg.quirk,
			sig,
		);
		// Keep only in-range indices, dedupe (a misbehaving backend could repeat
		// one), and present descending by score. An empty result is a failure —
		// fall back rather than silently dropping every candidate.
		const seen = new Set<number>();
		const ranked: ScoredChunk[] = [];
		for (const r of [...results].sort((a, b) => b.score - a.score)) {
			if (r.index < 0 || r.index >= docs.length || seen.has(r.index)) continue;
			seen.add(r.index);
			ranked.push({ index: r.index, score: r.score });
		}
		return ranked.length > 0 ? ranked : null;
	} catch (e) {
		console.warn('[retrieval] rerank failed, keeping fused order:', e);
		return null;
	}
}
