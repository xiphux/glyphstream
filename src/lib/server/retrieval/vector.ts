/**
 * Pure vector math for dense (embedding) retrieval. No dependencies, no I/O —
 * just dot/norm/cosine over float arrays, plus a ranking helper.
 *
 * Shared surface: `fetch_url`'s relevance selection uses this for the dense
 * leg of hybrid retrieval, and the `recall_memory` tool reuses the same
 * primitives (plus `encodeVector`/`decodeVector` below) against persisted
 * memory embeddings.
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

/**
 * Pack a dense vector as little-endian Float32 bytes for storage in a SQLite
 * BLOB column (`memories.embedding`). Float32 halves the size vs JSON and
 * round-trips losslessly through cosine, which tolerates the f64→f32 precision
 * drop. Pairs with `decodeVector`.
 */
export function encodeVector(v: number[]): Buffer {
	const f32 = Float32Array.from(v);
	return Buffer.from(f32.buffer, f32.byteOffset, f32.byteLength);
}

/**
 * Unpack a `memories.embedding` BLOB back into a `Float32Array` (a `Vec`, so it
 * feeds `cosine`/`cosineRank` directly). Accepts whatever the SQLite driver
 * hands back for a BLOB (Buffer or Uint8Array). Copies into a fresh, 4-byte-
 * aligned buffer first: a driver Buffer can be a view into a shared pool at an
 * unaligned `byteOffset`, which `Float32Array`'s constructor rejects.
 */
export function decodeVector(b: Buffer | Uint8Array): Float32Array {
	const copy = new Uint8Array(b.byteLength);
	copy.set(b);
	return new Float32Array(copy.buffer, 0, Math.floor(copy.byteLength / 4));
}
