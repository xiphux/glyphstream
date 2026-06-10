import { describe, expect, it } from 'vitest';
import { cosine, cosineRank, dot, norm } from '$lib/server/retrieval/vector';

describe('dot / norm', () => {
	it('computes the dot product', () => {
		expect(dot([1, 2, 3], [4, 5, 6])).toBe(32);
	});

	it('computes the Euclidean norm', () => {
		expect(norm([3, 4])).toBe(5);
	});

	it('throws on a dimension mismatch', () => {
		expect(() => dot([1, 2], [1, 2, 3])).toThrow(/dimension mismatch/);
	});
});

describe('cosine', () => {
	it('is 1 for identical direction', () => {
		expect(cosine([1, 2, 3], [2, 4, 6])).toBeCloseTo(1, 10);
	});

	it('is 0 for orthogonal vectors', () => {
		expect(cosine([1, 0], [0, 1])).toBeCloseTo(0, 10);
	});

	it('is -1 for opposite direction', () => {
		expect(cosine([1, 1], [-1, -1])).toBeCloseTo(-1, 10);
	});

	it('returns 0 when either vector is all-zeros', () => {
		expect(cosine([0, 0, 0], [1, 2, 3])).toBe(0);
	});

	it('interoperates between number[] and Float32Array', () => {
		const a = new Float32Array([1, 2, 3]);
		expect(cosine(a, [1, 2, 3])).toBeCloseTo(1, 6);
	});

	it('throws on a dimension mismatch', () => {
		expect(() => cosine([1, 2], [1, 2, 3])).toThrow(/dimension mismatch/);
	});
});

describe('cosineRank', () => {
	it('ranks docs by cosine similarity to the query, descending', () => {
		const query = [1, 0];
		const docs = [
			[0, 1], // orthogonal
			[1, 0], // identical
			[1, 0.1], // near-identical
		];
		const ranked = cosineRank(query, docs);
		expect(ranked[0].index).toBe(1);
		expect(ranked[1].index).toBe(2);
		expect(ranked[2].index).toBe(0);
	});

	it('breaks ties by ascending index', () => {
		const ranked = cosineRank(
			[1, 0],
			[
				[1, 0],
				[1, 0],
			],
		);
		expect(ranked.map((r) => r.index)).toEqual([0, 1]);
	});
});
