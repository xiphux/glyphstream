/**
 * Relevance selection: turn a chunked document + a query into the most
 * relevant slice that fits a char budget, in document order.
 *
 * Hybrid retrieval:
 *   - BM25 (always) — lexical precision on exact/rare terms.
 *   - Embedding cosine (when an embedding model is configured) — semantic
 *     recall on paraphrase.
 * The two rankings are fused with Reciprocal Rank Fusion (RRF), which needs no
 * score calibration between the retrievers. Any failure in the dense leg
 * (endpoint down, timeout, malformed response, dimension mismatch) degrades
 * silently to BM25-only — relevance selection must never turn a fetch into an
 * error.
 *
 * Cost is bounded: on very large documents we BM25-prefilter to EMBED_CAP
 * candidates before embedding, so a pathological page can't trigger an
 * unbounded number of embedding inputs.
 */

import { bm25Rank, type ScoredChunk } from './bm25';
import { embedAndRank, EMBED_CAP, type RelevanceConfig } from './embed-rank';
import { rerankDocs, type RerankConfig } from './rerank';
import { fuseRankings } from './fusion';
import type { Chunk } from './chunker';

// Re-exported so existing importers (`fetch-url.ts`, tests) keep their
// `from '../retrieval/select'` paths; both now live in embed-rank.ts alongside
// the dense-ranking they parameterize.
export { EMBED_CAP };
export type { RelevanceConfig };
export type { RerankConfig };

export interface SelectResult {
	content: string;
	mode: 'relevance';
	/**
	 * Breadcrumb trails of the sections actually returned in `content`, in
	 * document order (consecutive duplicates collapsed). Tells the model which
	 * parts of the page it's reading.
	 */
	sections: string[];
	/**
	 * Breadcrumb trails of every section in the full document, in document order.
	 * The superset of `sections` — tells the model what else exists so it can
	 * re-`find` to pull a section selection didn't return (multi-hop).
	 */
	outline: string[];
}

export const ELLIPSIS_MARKER = '\n\n[…]\n\n';

export async function selectRelevant(
	chunks: Chunk[],
	query: string,
	budgetChars: number,
	signal: AbortSignal,
	embedding?: RelevanceConfig,
	rerank?: RerankConfig,
): Promise<SelectResult> {
	// chunks are in document order, so a chunk's array index === blockIndex.
	const bm25 = bm25Rank(
		query,
		chunks.map((c) => c.text),
	);

	// Only POSITIVE scores are real lexical matches. `bm25Rank` deliberately
	// returns every chunk, zero-score ones in document order — which is a useful
	// total ordering on its own (BM25-only, below), but is NOT a lexical opinion.
	// Fusing the raw ranking hands RRF a full-strength "ranking" that is really
	// just document order, and on a `find` query with no term overlap that is
	// enough to outweigh a genuine semantic win. Same defect, and same fix, as
	// `retrieval/tool-search.ts`.
	const bm25Hits = bm25.filter((sc) => sc.score > 0);

	let ranking: ScoredChunk[] = bm25;

	if (embedding) {
		const candidates =
			chunks.length > EMBED_CAP ? bm25.slice(0, EMBED_CAP).map((sc) => chunks[sc.index]) : chunks;
		const dense = await embedAndRank(
			query,
			candidates.map((c) => c.text),
			embedding,
			signal,
		);
		if (dense) {
			// bm25's sc.index is already the chunk's blockIndex (chunks are in
			// document order). Remap the dense leg from candidate-subset space back
			// onto blockIndex so both rankings share one index space, then fuse.
			//
			// Both legs now carry a finite `missingRank`, so every chunk still gets a
			// contribution from both: a chunk with no lexical hit takes the SAME
			// lexical floor as every other non-hit (no spurious ordering between
			// them), leaving the dense leg to discriminate — which is the whole point
			// of the semantic leg. Chunks the dense leg never saw (only possible when
			// a page exceeds EMBED_CAP) keep their `EMBED_CAP + 1` floor as before.
			const denseByBlock = dense.map((sc) => ({
				index: candidates[sc.index].blockIndex,
				score: sc.score,
			}));
			ranking = completeRanking(
				fuseRankings([bm25Hits, denseByBlock], {
					missingRanks: [bm25Hits.length + 1, EMBED_CAP + 1],
				}),
				chunks.length,
			);
		}
	}

	if (rerank) {
		ranking = await applyRerank(chunks, ranking, query, rerank, signal);
	}

	const selected = packToBudget(chunks, ranking, budgetChars);
	selected.sort((a, b) => a.blockIndex - b.blockIndex);
	return {
		content: render(selected),
		mode: 'relevance',
		sections: distinctBreadcrumbs(selected),
		outline: distinctBreadcrumbs(chunks),
	};
}

/**
 * Distinct, non-empty breadcrumb trails from document-ordered chunks, collapsing
 * runs of the same trail (a multi-chunk section yields one entry). Inputs are
 * already in document order, so the output is too.
 */
function distinctBreadcrumbs(chunks: Chunk[]): string[] {
	const out: string[] = [];
	for (const c of chunks) {
		if (c.breadcrumb && c.breadcrumb !== out[out.length - 1]) out.push(c.breadcrumb);
	}
	return out;
}

/**
 * Rerank the top `cfg.topN` of the fused ranking with a cross-encoder, then
 * return a ranking with those candidates reordered to the front and the
 * untouched tail (everything past topN, plus any candidate the reranker didn't
 * place) kept in fused order behind them. On any rerank failure the fused
 * ranking is returned unchanged — reranking only ever reorders, never drops.
 */
async function applyRerank(
	chunks: Chunk[],
	ranking: ScoredChunk[],
	query: string,
	cfg: RerankConfig,
	signal: AbortSignal,
): Promise<ScoredChunk[]> {
	const head = ranking.slice(0, cfg.topN);
	if (head.length <= 1) return ranking;

	const reranked = await rerankDocs(
		query,
		head.map((sc) => chunks[sc.index].text),
		cfg,
		signal,
	);
	if (!reranked) return ranking;

	// `reranked` indices are positions within `head`. Place the reranked head
	// candidates first (in reranker order), then any head candidate the reranker
	// didn't return (fused order), then the original tail (fused order).
	const placed = new Set(reranked.map((sc) => sc.index));
	const reorderedHead = [
		...reranked.map((sc) => head[sc.index]),
		...head.filter((_, i) => !placed.has(i)),
	];
	return [...reorderedHead, ...ranking.slice(cfg.topN)];
}

/**
 * Restore totality to a fused ranking: `packToBudget` walks `ranking` and can
 * only ever select a chunk that appears in it, so every chunk must be present.
 *
 * RRF's universe is the union of the input legs. Once the lexical leg carries
 * only its real hits, a chunk can fall outside both legs — but only on a page
 * bigger than EMBED_CAP, where the dense leg saw just the prefiltered candidates.
 * Such a chunk has neither a lexical match nor an embedding, so it is genuinely
 * the least relevant thing on the page: append it at the tail, in document order.
 */
function completeRanking(fused: ScoredChunk[], chunkCount: number): ScoredChunk[] {
	if (fused.length === chunkCount) return fused;
	const ranked = new Set(fused.map((sc) => sc.index));
	const out = [...fused];
	for (let i = 0; i < chunkCount; i++) {
		if (!ranked.has(i)) out.push({ index: i, score: 0 });
	}
	return out;
}

/**
 * Greedily take chunks in rank order while they fit the budget (the cost
 * estimate uses chunk.text, an upper bound — breadcrumb-dedupe at render only
 * shrinks it). Keeps scanning past an over-large chunk so smaller relevant
 * chunks still fill the budget. Guarantees at least one chunk: if even the
 * top-ranked chunk exceeds the budget, it's sliced rather than dropped.
 */
function packToBudget(chunks: Chunk[], ranking: ScoredChunk[], budgetChars: number): Chunk[] {
	const selected: Chunk[] = [];
	let used = 0;
	for (let i = 0; i < ranking.length; i++) {
		const c = chunks[ranking[i].index];
		const overhead = selected.length > 0 ? ELLIPSIS_MARKER.length : 0;
		if (used + c.text.length + overhead <= budgetChars) {
			selected.push(c);
			used += c.text.length + overhead;
		} else if (i === 0) {
			// The most relevant chunk doesn't fit whole — slice it rather than
			// dropping it for a lower-ranked chunk that happens to be smaller.
			return [{ ...c, text: c.text.slice(0, budgetChars), body: c.body.slice(0, budgetChars) }];
		}
	}
	return selected;
}

/**
 * Render document-ordered chunks. Consecutive chunks (blockIndex n, n+1) join
 * with a blank line — same section drops the repeated breadcrumb and strips
 * the overlap prefix; a section change re-shows the breadcrumb. A gap in
 * blockIndex inserts an ellipsis marker so the model knows content was elided.
 */
function render(selected: Chunk[]): string {
	let out = '';
	for (let i = 0; i < selected.length; i++) {
		const c = selected[i];
		const prev = i > 0 ? selected[i - 1] : null;
		const adjacent = prev !== null && prev.blockIndex === c.blockIndex - 1;

		if (prev === null) {
			out += c.text;
			continue;
		}
		if (adjacent && c.breadcrumb === prev.breadcrumb) {
			// Continuation of the same section: dedupe overlap, no breadcrumb repeat.
			const body = c.overlapPrefixLen > 0 ? c.body.slice(c.overlapPrefixLen).trimStart() : c.body;
			out += `\n\n${body}`;
		} else if (adjacent) {
			// Adjacent in the document but a new section started — re-show breadcrumb.
			out += `\n\n${c.text}`;
		} else {
			out += `${ELLIPSIS_MARKER}${c.text}`;
		}
	}
	return out;
}
