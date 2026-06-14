/**
 * Reciprocal Rank Fusion over rankings that share one index space.
 *
 * Each input ranking is an ordered `ScoredChunk[]` (the array position is the
 * rank; the `score` is ignored). An item's fused score is the sum over rankings
 * of `1 / (k + rank)`, with `rank` 1-based — so an item missing from a ranking
 * simply contributes nothing from it. RRF needs no score calibration between
 * retrievers, which is the whole point: a BM25 ranking and a cosine ranking can
 * be combined without normalizing their incomparable score scales.
 *
 * `select.ts` keeps its own chunk-shaped fuser (`fuseRrf`) because it has to map
 * a prefiltered candidate subset back onto document `blockIndex` with per-leg
 * backfill ranks. This generic version is for callers whose rankings already
 * live in a single flat index space (e.g. `tool-search.ts`).
 */

import type { ScoredChunk } from './bm25';

export const RRF_K = 60;

export function fuseRankings(rankings: ScoredChunk[][], opts: { k?: number } = {}): ScoredChunk[] {
	const k = opts.k ?? RRF_K;
	const scores = new Map<number, number>();
	for (const ranking of rankings) {
		ranking.forEach((sc, r) => {
			// r is 0-based; RRF rank is 1-based.
			scores.set(sc.index, (scores.get(sc.index) ?? 0) + 1 / (k + r + 1));
		});
	}
	const fused = [...scores.entries()].map(([index, score]) => ({ index, score }));
	// Descending score; ties broken by ascending index for stable output.
	fused.sort((x, y) => (y.score === x.score ? x.index - y.index : y.score - x.score));
	return fused;
}
