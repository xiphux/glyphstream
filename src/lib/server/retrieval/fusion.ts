/**
 * Reciprocal Rank Fusion over rankings that share one index space.
 *
 * Each input ranking is an ordered `ScoredChunk[]` (the array position is the
 * rank; the `score` is ignored). An item's fused score is the sum over rankings
 * of `1 / (k + rank)`, with `rank` 1-based. RRF needs no score calibration
 * between retrievers, which is the whole point: a BM25 ranking and a cosine
 * ranking can be combined without normalizing their incomparable score scales.
 *
 * By default an item missing from a ranking simply contributes nothing from it
 * (the standard RRF behavior, equivalent to a backfill rank of ∞). A caller that
 * needs a *finite* backfill for absent items — so a known universe of items each
 * gets a small floor contribution from every leg — passes `missingRanks` (one
 * 1-based rank per ranking). `select.ts` uses this to fuse a full chunk set where
 * the dense leg only ranked a BM25-prefiltered subset: chunks the dense leg never
 * saw still get its `EMBED_CAP + 1` floor instead of zero.
 */

import type { ScoredChunk } from './bm25';

export const RRF_K = 60;

export interface FuseOptions {
	/** RRF constant (default {@link RRF_K}). */
	k?: number;
	/**
	 * Per-ranking 1-based rank assigned to universe items absent from that
	 * ranking, aligned with `rankings`. When omitted (or undefined for a leg),
	 * absent items contribute nothing from that leg — standard RRF. The "universe"
	 * is the union of every item appearing in any ranking.
	 */
	missingRanks?: (number | undefined)[];
}

export function fuseRankings(rankings: ScoredChunk[][], opts: FuseOptions = {}): ScoredChunk[] {
	const k = opts.k ?? RRF_K;
	const missingRanks = opts.missingRanks;

	// The universe is every item appearing in any ranking. Only matters when a
	// leg has a finite `missingRank` — then each universe item absent from that
	// leg still gets its floor contribution.
	const universe = new Set<number>();
	const rankByIndexPerLeg = rankings.map((ranking) => {
		const m = new Map<number, number>();
		// r is 0-based; RRF rank is 1-based.
		ranking.forEach((sc, r) => {
			m.set(sc.index, r + 1);
			universe.add(sc.index);
		});
		return m;
	});

	const scores = new Map<number, number>();
	rankByIndexPerLeg.forEach((rankByIndex, leg) => {
		const missingRank = missingRanks?.[leg];
		for (const index of universe) {
			const rank = rankByIndex.get(index) ?? missingRank;
			if (rank === undefined) continue; // absent + no floor → contributes 0
			scores.set(index, (scores.get(index) ?? 0) + 1 / (k + rank));
		}
	});

	const fused = [...scores.entries()].map(([index, score]) => ({ index, score }));
	// Descending score; ties broken by ascending index for stable output.
	fused.sort((x, y) => (y.score === x.score ? x.index - y.index : y.score - x.score));
	return fused;
}
