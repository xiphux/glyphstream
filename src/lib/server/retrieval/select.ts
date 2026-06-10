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

import type { LoadedEndpoint } from '../endpoints/config';
import { embeddings } from '../endpoints/client';
import { composeSignals } from '../util/abort';
import { bm25Rank, type ScoredChunk } from './bm25';
import { cosineRank, type Vec } from './vector';
import type { Chunk } from './chunker';

export interface RelevanceConfig {
	endpoint: LoadedEndpoint;
	modelId: string;
	timeoutSeconds: number;
	embedCap: number;
	/** Task prefixes for the query and each document (default ''). */
	queryPrefix: string;
	documentPrefix: string;
	/** Model max input sequence length (tokens); drives per-input truncation. */
	maxInputTokens: number;
}

export interface SelectResult {
	content: string;
	mode: 'relevance';
}

export const ELLIPSIS_MARKER = '\n\n[…]\n\n';
export const RRF_K = 60;

// How many BM25-top candidates get embedded. The BM25 prefilter already
// narrows to the strongest lexical matches, so a few dozen is plenty to
// rerank into the ~10-12 chunks that fit the output budget — and it bounds
// embedding cost on large pages.
export const EMBED_CAP = 64;

// Embedding backends (notably llama-server) cap both per-input length and the
// per-request batch: an input over the model's max sequence length 500s, and
// large batches drop the connection. So we truncate each input (to a char
// budget derived from the configured maxInputTokens) and split candidates
// across several modestly-sized requests. The batch ceilings are conservative
// to work across backends; on a roomier server they just mean a few extra
// requests.
//
// Chars-per-token is deliberately a low estimate so the char cap UNDER-fills
// the token limit (English averages ~4; under-estimating keeps us clear of a
// 500 on token-dense inputs).
const CHARS_PER_TOKEN = 3.5;
const EMBED_BATCH_MAX_ITEMS = 8;
const EMBED_BATCH_MAX_CHARS = 12000;

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
		const dense = await denseRanking(query, candidates, embedding, signal);
		if (dense) {
			ranking = fuseRrf(chunks, bm25, dense, candidates, embedding.embedCap);
		}
	}

	const selected = packToBudget(chunks, ranking, budgetChars);
	selected.sort((a, b) => a.blockIndex - b.blockIndex);
	return { content: render(selected), mode: 'relevance' };
}

/**
 * Embed [query, ...candidates] across one or more batched HTTP calls and rank
 * candidates by cosine to the query. Returns ScoredChunk indices relative to
 * `candidates`, or null on any failure (caller degrades to BM25).
 */
async function denseRanking(
	query: string,
	candidates: Chunk[],
	cfg: RelevanceConfig,
	signal: AbortSignal,
): Promise<ScoredChunk[] | null> {
	try {
		// Apply task prefixes (e.g. nomic/e5 "search_query:"/"search_document:")
		// and cap each input so it stays under the model's max sequence length.
		const inputCap = Math.max(1, Math.floor(cfg.maxInputTokens * CHARS_PER_TOKEN));
		const inputs = [
			cfg.queryPrefix + truncate(query, inputCap),
			...candidates.map((c) => cfg.documentPrefix + truncate(c.text, inputCap)),
		];

		const sig = composeSignals(signal, AbortSignal.timeout(cfg.timeoutSeconds * 1000));
		const batches = batchInputs(inputs, EMBED_BATCH_MAX_ITEMS, EMBED_BATCH_MAX_CHARS);
		const responses = await Promise.all(
			batches.map((input) => embeddings(cfg.endpoint, { model: cfg.modelId, input }, sig)),
		);

		// Reassemble vectors in global input order: batches are issued in order
		// and Promise.all preserves it; within each, sort by the response index.
		const vecs: number[][] = [];
		responses.forEach((resp, b) => {
			const data = resp.data;
			if (!Array.isArray(data) || data.length !== batches[b].length) {
				throw new Error(
					`batch ${b}: expected ${batches[b].length} embeddings, got ${data?.length ?? 0}`,
				);
			}
			[...data]
				.sort((x, y) => (x.index ?? 0) - (y.index ?? 0))
				.forEach((d) => vecs.push(d.embedding as number[]));
		});

		if (vecs.length !== inputs.length) {
			throw new Error(`expected ${inputs.length} embeddings, got ${vecs.length}`);
		}
		const dim = vecs[0]?.length ?? 0;
		if (dim === 0 || vecs.some((v) => !Array.isArray(v) || v.length !== dim)) {
			throw new Error('missing or non-uniform embedding dimensions');
		}
		return cosineRank(vecs[0] as Vec, vecs.slice(1) as Vec[]);
	} catch (e) {
		console.warn('[retrieval] embedding retrieval failed, falling back to BM25:', e);
		return null;
	}
}

function truncate(s: string, maxChars: number): string {
	return s.length <= maxChars ? s : s.slice(0, maxChars);
}

/** Split inputs into requests bounded by item count and total chars. */
function batchInputs(inputs: string[], maxItems: number, maxChars: number): string[][] {
	const batches: string[][] = [];
	let current: string[] = [];
	let chars = 0;
	for (const s of inputs) {
		if (current.length > 0 && (current.length >= maxItems || chars + s.length > maxChars)) {
			batches.push(current);
			current = [];
			chars = 0;
		}
		current.push(s);
		chars += s.length;
	}
	if (current.length > 0) batches.push(current);
	return batches;
}

/** Fuse BM25 + dense rankings via RRF over the full chunk set. */
function fuseRrf(
	chunks: Chunk[],
	bm25: ScoredChunk[],
	dense: ScoredChunk[],
	candidates: Chunk[],
	embedCap: number,
): ScoredChunk[] {
	const bm25RankByBlock = new Map<number, number>();
	bm25.forEach((sc, r) => bm25RankByBlock.set(sc.index, r + 1));

	const denseRankByBlock = new Map<number, number>();
	dense.forEach((sc, r) => denseRankByBlock.set(candidates[sc.index].blockIndex, r + 1));

	const fused = chunks.map((c) => {
		const rb = bm25RankByBlock.get(c.blockIndex) ?? chunks.length + 1;
		const rd = denseRankByBlock.get(c.blockIndex) ?? embedCap + 1;
		return { index: c.blockIndex, score: 1 / (RRF_K + rb) + 1 / (RRF_K + rd) };
	});
	fused.sort((x, y) => (y.score === x.score ? x.index - y.index : y.score - x.score));
	return fused;
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
