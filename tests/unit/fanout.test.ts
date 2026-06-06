/**
 * Unit tests for the client-side fan-out helpers: expanding the compare
 * "cart" (model id → count) into one FanoutModel per copy, and the
 * all-columns-settled predicate the page uses to gate pick/dismiss.
 */

import { describe, expect, it } from 'vitest';
import {
	allColumnsSettled,
	expandCompareSelections,
	type CompareSelection,
	type FanoutColumn,
} from '$lib/fanout';

const resolve = (id: string) => {
	const table: Record<string, { displayName: string; modelKind: 'chat' }> = {
		'bridge::a': { displayName: 'Model A', modelKind: 'chat' },
		'bridge::b': { displayName: 'Model B', modelKind: 'chat' },
	};
	return table[id];
};

describe('expandCompareSelections', () => {
	it('expands each selection into `count` FanoutModel entries in order', () => {
		const sel: CompareSelection[] = [
			{ modelId: 'bridge::a', count: 2 },
			{ modelId: 'bridge::b', count: 1 },
		];
		expect(expandCompareSelections(sel, resolve)).toEqual([
			{ modelId: 'bridge::a', modelKind: 'chat', displayName: 'Model A' },
			{ modelId: 'bridge::a', modelKind: 'chat', displayName: 'Model A' },
			{ modelId: 'bridge::b', modelKind: 'chat', displayName: 'Model B' },
		]);
	});

	it('skips selections whose model no longer resolves', () => {
		const sel: CompareSelection[] = [
			{ modelId: 'bridge::a', count: 1 },
			{ modelId: 'bridge::gone', count: 3 },
		];
		expect(expandCompareSelections(sel, resolve)).toEqual([
			{ modelId: 'bridge::a', modelKind: 'chat', displayName: 'Model A' },
		]);
	});

	it('returns empty for an empty cart', () => {
		expect(expandCompareSelections([], resolve)).toEqual([]);
	});
});

describe('allColumnsSettled', () => {
	const col = (status: FanoutColumn['status']): FanoutColumn => ({
		branchId: 'b',
		modelId: 'bridge::a',
		modelKind: 'chat',
		label: 'A',
		segments: [],
		status,
		queuedAhead: 0,
		progress: null,
		persisted: null,
		error: null,
	});

	it('is false while any column is queued or streaming', () => {
		expect(allColumnsSettled([col('done'), col('streaming')])).toBe(false);
		expect(allColumnsSettled([col('done'), col('queued')])).toBe(false);
	});

	it('is true once every column is done/error/cancelled', () => {
		expect(allColumnsSettled([col('done'), col('error'), col('cancelled')])).toBe(true);
	});

	it('is true for an empty set (vacuous)', () => {
		expect(allColumnsSettled([])).toBe(true);
	});
});
