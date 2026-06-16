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
// Cap how many batch requests are in flight at once. The batch split above keeps
// each request under a backend's per-request ceiling; this keeps a large
// candidate set from fanning out ALL its batches simultaneously at a single
// self-hosted backend (e.g. llama-server), which reproduces the same overload
// (connection drops) the batching was meant to avoid. A roomy backend still
// parallelizes up to this many; a small one isn't flooded.
const EMBED_MAX_CONCURRENCY = 3;

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
	// Apply task prefixes (e.g. nomic/e5 "search_query:"/"search_document:")
	// and cap each input so it stays under the model's max sequence length.
	const inputCap = Math.max(1, Math.floor(cfg.maxInputTokens * CHARS_PER_TOKEN));
	const inputs = [
		cfg.queryPrefix + truncate(query, inputCap),
		...docs.map((d) => cfg.documentPrefix + truncate(d, inputCap)),
	];
	const vecs = await embedInputs(inputs, cfg, signal);
	if (!vecs) return null;
	return cosineRank(vecs[0] as Vec, vecs.slice(1) as Vec[]);
}

/**
 * Like {@link embedAndRank}, but reuses cached document vectors across calls
 * (keyed by model + prepared input) so a static corpus — e.g. the deferred-tool
 * catalog — is embedded once, not on every search. The query is always
 * re-embedded (it's different each call); only uncached docs are sent upstream,
 * riding the same batched/bounded request as the query. The cache is the
 * caller's, so it controls lifetime/eviction. Returns ScoredChunk indices
 * relative to `docs`, or null on any failure.
 */
export async function embedAndRankCached(
	query: string,
	docs: string[],
	cfg: RelevanceConfig,
	signal: AbortSignal,
	cache: Map<string, Vec>,
): Promise<ScoredChunk[] | null> {
	try {
		const inputCap = Math.max(1, Math.floor(cfg.maxInputTokens * CHARS_PER_TOKEN));
		const queryInput = cfg.queryPrefix + truncate(query, inputCap);
		const docInputs = docs.map((d) => cfg.documentPrefix + truncate(d, inputCap));
		// Vectors live in the same space only within one model; key on it so a model
		// change can't serve stale-space vectors. The prepared input already carries
		// the document prefix, so prefix changes key distinctly too.
		const keyFor = (docInput: string) => `${cfg.modelId}\n${docInput}`;

		const missIdx = docInputs.map((_, i) => i).filter((i) => !cache.has(keyFor(docInputs[i])));

		// Embed the query (always) + any uncached docs in one batched request.
		const inputs = [queryInput, ...missIdx.map((i) => docInputs[i])];
		const vecs = await embedInputs(inputs, cfg, signal);
		if (!vecs) return null;
		missIdx.forEach((i, j) => cache.set(keyFor(docInputs[i]), vecs[j + 1] as Vec));

		const queryVec = vecs[0] as Vec;
		const docVecs = docInputs.map((d) => cache.get(keyFor(d)) as Vec);
		return cosineRank(queryVec, docVecs);
	} catch (e) {
		console.warn('[retrieval] cached embedding ranking failed, falling back to BM25:', e);
		return null;
	}
}

/**
 * Embed a list of already-prepared input strings (prefixes + truncation applied
 * by the caller) and return their vectors in input order, or null on ANY
 * failure (endpoint down, timeout, malformed/short response, non-uniform
 * dimensions). Splits across bounded batches and caps in-flight concurrency.
 */
async function embedInputs(
	inputs: string[],
	cfg: RelevanceConfig,
	signal: AbortSignal,
): Promise<number[][] | null> {
	try {
		const sig = composeSignals(signal, AbortSignal.timeout(cfg.timeoutSeconds * 1000));
		const batches = batchInputs(inputs, EMBED_BATCH_MAX_ITEMS, EMBED_BATCH_MAX_CHARS);
		const responses = await mapBounded(batches, EMBED_MAX_CONCURRENCY, (input) =>
			embeddings(cfg.endpoint, { model: cfg.modelId, input }, sig),
		);

		// Reassemble vectors in global input order: batches are issued in order and
		// mapBounded preserves it; within each, sort by the response index.
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
		return vecs;
	} catch (e) {
		console.warn('[retrieval] embedding request failed, falling back to BM25:', e);
		return null;
	}
}

/**
 * Map `items` through `fn` with at most `limit` calls in flight at once,
 * preserving input order in the result. A small worker pool drains a shared
 * cursor.
 */
async function mapBounded<T, R>(
	items: T[],
	limit: number,
	fn: (item: T) => Promise<R>,
): Promise<R[]> {
	const results: R[] = new Array(items.length);
	let cursor = 0;
	async function worker(): Promise<void> {
		while (cursor < items.length) {
			const i = cursor++;
			results[i] = await fn(items[i]);
		}
	}
	const workers: Promise<void>[] = [];
	for (let w = 0; w < Math.min(limit, items.length); w++) workers.push(worker());
	await Promise.all(workers);
	return results;
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
