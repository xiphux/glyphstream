/**
 * Tests for the branch-walk helpers — the index + deepest-descendant walk
 * that selectBranch and deleteBranch share, including the tie-break that
 * both must agree on.
 */

import { describe, expect, it } from 'vitest';
import { buildChildrenByParent, deepestDescendant } from '$lib/server/db/queries/messages';

describe('buildChildrenByParent', () => {
	it('groups rows by parent id, skipping roots', () => {
		const rows = [
			{ id: 'a', parentId: null },
			{ id: 'b', parentId: 'a' },
			{ id: 'c', parentId: 'a' }
		];
		const map = buildChildrenByParent(rows);
		expect(map.get('a')?.map((r) => r.id)).toEqual(['b', 'c']);
		expect(map.size).toBe(1);
	});
});

describe('deepestDescendant', () => {
	it('returns the start id when it has no children', () => {
		expect(deepestDescendant('leaf', buildChildrenByParent([]))).toBe('leaf');
	});

	it('walks to the deepest descendant', () => {
		const rows = [
			{ id: 'root', parentId: null, createdAt: 0 },
			{ id: 'child', parentId: 'root', createdAt: 1 },
			{ id: 'grandchild', parentId: 'child', createdAt: 2 }
		];
		expect(deepestDescendant('root', buildChildrenByParent(rows))).toBe('grandchild');
	});

	it('prefers the most recent child, breaking ties by id descending', () => {
		const byTime = [
			{ id: 'older', parentId: 'root', createdAt: 1 },
			{ id: 'newer', parentId: 'root', createdAt: 2 }
		];
		expect(deepestDescendant('root', buildChildrenByParent(byTime))).toBe('newer');

		const tie = [
			{ id: 'aaa', parentId: 'root', createdAt: 5 },
			{ id: 'bbb', parentId: 'root', createdAt: 5 }
		];
		expect(deepestDescendant('root', buildChildrenByParent(tie))).toBe('bbb');
	});
});
