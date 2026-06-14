/**
 * Shared dense (embedding) ranking. Embed `[query, ...docs]` across bounded
 * batches and rank docs by cosine similarity to the query. Returns ScoredChunk
 * indices relative to `docs`, or null on ANY failure (endpoint down, timeout,
 * malformed response, dimension mismatch) so callers degrade to BM25-only — a
 * failed dense leg must never turn the calling tool into an error.
 *
 * Two consumers share this: `select.ts` (document relevance for `fetch_url`) and
 * `tool-search.ts` (deferred-tool search). Cost is the caller's concern — both
 * BM25-prefilter to EMBED_CAP candidates before calling, so a pathological input
 * can't trigger an unbounded number of embedding inputs.
 */

import type { LoadedEndpoint } from '../endpoints/config';
import { embeddings } from '../endpoints/client';
import { composeSignals } from '../util/abort';
import type { ScoredChunk } from './bm25';
import { cosineRank, type Vec } from './vector';

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

/**
 * Embed [query, ...docs] and rank `docs` by cosine to the query. Returns
 * ScoredChunk indices relative to `docs`, or null on any failure.
 */
export async function embedAndRank(
	query: string,
	docs: string[],
	cfg: RelevanceConfig,
	signal: AbortSignal,
): Promise<ScoredChunk[] | null> {
	try {
		// Apply task prefixes (e.g. nomic/e5 "search_query:"/"search_document:")
		// and cap each input so it stays under the model's max sequence length.
		const inputCap = Math.max(1, Math.floor(cfg.maxInputTokens * CHARS_PER_TOKEN));
		const inputs = [
			cfg.queryPrefix + truncate(query, inputCap),
			...docs.map((d) => cfg.documentPrefix + truncate(d, inputCap)),
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
		console.warn('[retrieval] embedding ranking failed, falling back to BM25:', e);
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
