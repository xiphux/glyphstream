/**
 * Pure vector math for dense (embedding) retrieval. No dependencies, no I/O —
 * just dot/norm/cosine over float arrays, plus a ranking helper.
 *
 * Shared surface: `fetch_url`'s relevance selection uses this for the dense
 * leg of hybrid retrieval, and the planned `recall_memory` tool (memory
 * phase-2) reuses the same primitives against persisted memory embeddings.
 *
 * Accepts both `number[]` (the shape the OpenAI `/v1/embeddings` JSON decodes
 * to) and `Float32Array` (the shape memory blobs decode to), so callers on
 * either side share one implementation.
 */

import type { ScoredChunk } from './bm25';

export type Vec = number[] | Float32Array;

export function dot(a: Vec, b: Vec): number {
	if (a.length !== b.length) {
		throw new Error(`vector dimension mismatch: ${a.length} vs ${b.length}`);
	}
	let sum = 0;
	for (let i = 0; i < a.length; i++) sum += a[i] * b[i];
	return sum;
}

export function norm(a: Vec): number {
	let sum = 0;
	for (let i = 0; i < a.length; i++) sum += a[i] * a[i];
	return Math.sqrt(sum);
}

/**
 * Cosine similarity in [-1, 1]. Returns 0 when either vector is all-zeros
 * (no direction to compare) rather than dividing by zero. Throws on a
 * dimension mismatch — the caller treats that as a failed dense leg and
 * degrades to lexical-only.
 */
export function cosine(a: Vec, b: Vec): number {
	const na = norm(a);
	const nb = norm(b);
	if (na === 0 || nb === 0) return 0;
	return dot(a, b) / (na * nb);
}

/**
 * Rank `docs` by cosine similarity to `query`, descending. Ties break by
 * ascending index for stability (and a mild document-order bias, matching
 * `bm25Rank`). Reuses `ScoredChunk` so fusion can treat both retrievers'
 * outputs uniformly.
 */
export function cosineRank(query: Vec, docs: Vec[]): ScoredChunk[] {
	const scored = docs.map((d, index) => ({ index, score: cosine(query, d) }));
	scored.sort((x, y) => (y.score === x.score ? x.index - y.index : y.score - x.score));
	return scored;
}
