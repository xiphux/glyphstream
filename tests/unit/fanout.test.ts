/**
 * Unit tests for the client-side fan-out helpers: expanding the compare
 * "cart" (model id → count) into one FanoutModel per copy, and the
 * all-columns-settled predicate the page uses to gate pick/dismiss.
 */

import { describe, expect, it } from 'vitest';
import {
	allColumnsSettled,
	expandCompareSelections,
	expandFanoutBranches,
	isMediaKind,
	type CompareSelection,
	type FanoutColumn,
	type FanoutModel,
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

describe('expandFanoutBranches', () => {
	const img = (id: string): FanoutModel => ({ modelId: id, modelKind: 'image', displayName: id });
	const a = img('bridge::a');
	const b = img('bridge::b');

	it('without split → one branch per model, no input override', () => {
		expect(expandFanoutBranches([a, b], null)).toEqual([
			{ ...a, inputMediaId: null },
			{ ...b, inputMediaId: null },
		]);
		// Empty split list is treated the same as no split.
		expect(expandFanoutBranches([a], [])).toEqual([{ ...a, inputMediaId: null }]);
	});

	it('crosses models with split images, image-outer / model-inner', () => {
		expect(expandFanoutBranches([a, b], ['m1', 'm2'])).toEqual([
			{ ...a, inputMediaId: 'm1' },
			{ ...b, inputMediaId: 'm1' },
			{ ...a, inputMediaId: 'm2' },
			{ ...b, inputMediaId: 'm2' },
		]);
	});

	it('single model split across N images → N branches (the headline case)', () => {
		const out = expandFanoutBranches([a], ['m1', 'm2', 'm3']);
		expect(out.map((x) => x.inputMediaId)).toEqual(['m1', 'm2', 'm3']);
		expect(out.every((x) => x.modelId === 'bridge::a')).toBe(true);
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
		statusLabel: null,
		startedAt: null,
		inputMediaId: null,
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

describe('isMediaKind', () => {
	it('is true for image and video (keep-many)', () => {
		expect(isMediaKind('image')).toBe(true);
		expect(isMediaKind('video')).toBe(true);
	});

	it('is false for chat, embedding, and absent kinds (pick-one / n/a)', () => {
		expect(isMediaKind('chat')).toBe(false);
		expect(isMediaKind('embedding')).toBe(false);
		expect(isMediaKind(null)).toBe(false);
		expect(isMediaKind(undefined)).toBe(false);
	});
});
