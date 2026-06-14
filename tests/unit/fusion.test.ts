import { describe, expect, it } from 'vitest';
import { fuseRankings, RRF_K } from '$lib/server/retrieval/fusion';
import type { ScoredChunk } from '$lib/server/retrieval/bm25';

/** Build a ranking from indices in rank order (scores are ignored by RRF). */
function ranking(...indices: number[]): ScoredChunk[] {
	return indices.map((index) => ({ index, score: 0 }));
}

describe('fuseRankings', () => {
	it('a single ranking passes through in the same order', () => {
		const fused = fuseRankings([ranking(2, 0, 1)]);
		expect(fused.map((s) => s.index)).toEqual([2, 0, 1]);
	});

	it('sums 1/(k+rank) across rankings with rank 1-based', () => {
		// One ranking [0,1]: idx0 at rank 1, idx1 at rank 2.
		const fused = fuseRankings([ranking(0, 1)]);
		const byIndex = new Map(fused.map((s) => [s.index, s.score]));
		expect(byIndex.get(0)).toBeCloseTo(1 / (RRF_K + 1), 10);
		expect(byIndex.get(1)).toBeCloseTo(1 / (RRF_K + 2), 10);
	});

	it('rewards agreement: an item ranked highly by both legs wins', () => {
		// idx2 is rank 1 in both legs; idx0/idx1 split the other top spots.
		const fused = fuseRankings([ranking(2, 0, 1), ranking(2, 1, 0)]);
		expect(fused[0].index).toBe(2);
	});

	it('breaks ties by ascending index', () => {
		// Mirror-image rankings give idx0 and idx1 identical fused scores.
		const fused = fuseRankings([ranking(0, 1), ranking(1, 0)]);
		expect(fused.map((s) => s.index)).toEqual([0, 1]);
		expect(fused[0].score).toBeCloseTo(fused[1].score, 10);
	});

	it('scores an item present in only one ranking (missing = no contribution)', () => {
		const fused = fuseRankings([ranking(0, 1), ranking(0)]);
		const byIndex = new Map(fused.map((s) => [s.index, s.score]));
		// idx0 appears in both (rank 1 + rank 1); idx1 only in the first (rank 2).
		expect(byIndex.get(0)).toBeCloseTo(2 / (RRF_K + 1), 10);
		expect(byIndex.get(1)).toBeCloseTo(1 / (RRF_K + 2), 10);
		expect(fused[0].index).toBe(0);
	});

	it('returns [] for no rankings', () => {
		expect(fuseRankings([])).toEqual([]);
	});
});
