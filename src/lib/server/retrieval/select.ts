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
import { embedAndRank, type RelevanceConfig } from './embed-rank';
import { fuseRankings } from './fusion';
import type { Chunk } from './chunker';

// Re-exported so existing importers (`fetch-url.ts`, tests) keep their
// `from '../retrieval/select'` paths; the type now lives in embed-rank.ts
// alongside the dense-ranking it parameterizes.
export type { RelevanceConfig };

export interface SelectResult {
	content: string;
	mode: 'relevance';
}

export const ELLIPSIS_MARKER = '\n\n[…]\n\n';

// How many BM25-top candidates get embedded. The BM25 prefilter already
// narrows to the strongest lexical matches, so a few dozen is plenty to
// rerank into the ~10-12 chunks that fit the output budget — and it bounds
// embedding cost on large pages. (The per-input truncation + request batching
// that keeps embedding backends happy lives in embed-rank.ts.)
export const EMBED_CAP = 64;

export async function selectRelevant(
	chunks: Chunk[],
	query: string,
	budgetChars: number,
	signal: AbortSignal,
	embedding?: RelevanceConfig,
): Promise<SelectResult> {
	// chunks are in document order, so a chunk's array index === blockIndex.
	const bm25 = bm25Rank(
		query,
		chunks.map((c) => c.text),
	);

	let ranking: ScoredChunk[] = bm25;

	if (embedding) {
		const candidates =
			chunks.length > embedding.embedCap
				? bm25.slice(0, embedding.embedCap).map((sc) => chunks[sc.index])
				: chunks;
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
			// bm25 covers every chunk, so its missingRank never fires; the dense leg
			// only ranked the prefiltered candidates, so chunks it never saw get the
			// `embedCap + 1` floor (preserving the prior hand-rolled fusion exactly).
			const denseByBlock = dense.map((sc) => ({
				index: candidates[sc.index].blockIndex,
				score: sc.score,
			}));
			ranking = fuseRankings([bm25, denseByBlock], {
				missingRanks: [chunks.length + 1, embedding.embedCap + 1],
			});
		}
	}

	const selected = packToBudget(chunks, ranking, budgetChars);
	selected.sort((a, b) => a.blockIndex - b.blockIndex);
	return { content: render(selected), mode: 'relevance' };
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
