/**
 * Unit tests for the client-side fan-out helpers: expanding the compare
 * "cart" (model id → count) into one FanoutModel per copy, and the
 * all-columns-settled predicate the page uses to gate pick/dismiss.
 */

import { describe, expect, it } from 'vitest';
import {
	allColumnsSettled,
	applyDisplayOrder,
	nextDispatchIndex,
	rerollInsertIndex,
	collapseToCompareSelections,
	expandCompareSelections,
	expandFanoutBranches,
	gridMediaIds,
	isMediaKind,
	resolveActiveModelKind,
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

describe('collapseToCompareSelections', () => {
	const m = (id: string): FanoutModel => ({ modelId: id, modelKind: 'chat', displayName: id });

	it('round-trips an expanded cart back to its counts, in first-seen order', () => {
		const cart: CompareSelection[] = [
			{ modelId: 'bridge::b', count: 1 },
			{ modelId: 'bridge::a', count: 2 },
		];
		expect(collapseToCompareSelections(expandCompareSelections(cart, resolve))).toEqual(cart);
	});

	it('returns empty for no models', () => {
		expect(collapseToCompareSelections([])).toEqual([]);
	});

	// Guards the reason this takes models rather than branches: with split
	// attachments each model repeats once per input image, so collapsing the
	// cross-product would multiply every count by the image count.
	it('is not fed branches — the cross-product would inflate counts', () => {
		const models = [m('bridge::a'), m('bridge::b')];
		const branches = expandFanoutBranches(models, ['img-1', 'img-2']);
		expect(collapseToCompareSelections(models)).toEqual([
			{ modelId: 'bridge::a', count: 1 },
			{ modelId: 'bridge::b', count: 1 },
		]);
		expect(collapseToCompareSelections(branches)).toEqual([
			{ modelId: 'bridge::a', count: 2 },
			{ modelId: 'bridge::b', count: 2 },
		]);
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
		dispatchIndex: 0,
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
		errorMessageId: null,
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

describe('resolveActiveModelKind', () => {
	it('uses the single kind when no compare set is active', () => {
		expect(resolveActiveModelKind(false, [], 'chat')).toBe('chat');
		expect(resolveActiveModelKind(false, [], 'image')).toBe('image');
		// Compare mode but an empty cart still falls back to the single kind.
		expect(resolveActiveModelKind(true, [], 'chat')).toBe('chat');
	});

	it('uses the compare cart kind when a set is active (overriding the single kind)', () => {
		// Text single model + an image set → image (the placeholder/toggle bug).
		expect(resolveActiveModelKind(true, ['image', 'image'], 'chat')).toBe('image');
		// Image single model + a text set → chat (the inverse bug).
		expect(resolveActiveModelKind(true, ['chat', 'chat'], 'image')).toBe('chat');
		expect(resolveActiveModelKind(true, ['video'], 'image')).toBe('video');
	});

	it('passes a null single kind through (unknown)', () => {
		expect(resolveActiveModelKind(false, [], null)).toBeNull();
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

describe('gridMediaIds + applyDisplayOrder', () => {
	// A settled image branch holding one output.
	const shot = (branchId: string, ...mediaIds: string[]): FanoutColumn => ({
		branchId,
		dispatchIndex: 0,
		modelId: 'bridge::a',
		modelKind: 'image',
		label: 'A',
		segments: [],
		status: 'done',
		queuedAhead: 0,
		progress: null,
		statusLabel: null,
		startedAt: null,
		inputMediaId: null,
		persisted: {
			id: `msg-${branchId}`,
			role: 'assistant',
			parts: mediaIds.map((mediaId) => ({ type: 'image' as const, mediaId })),
			createdAt: 0,
		} as FanoutColumn['persisted'],
		error: null,
		errorMessageId: null,
	});
	const pending = (branchId: string): FanoutColumn => ({
		...shot(branchId),
		status: 'streaming',
		persisted: null,
	});
	const ref = (id: string) => ({ id, kind: 'image' as const });

	it('reads the grid’s media in column order, batches included', () => {
		expect(gridMediaIds([shot('b0', 'm1', 'm2'), shot('b1', 'm3')])).toEqual(['m1', 'm2', 'm3']);
	});

	it('skips columns that have nothing on screen yet', () => {
		expect(gridMediaIds([pending('b0'), shot('b1', 'm3'), pending('b2')])).toEqual(['m3']);
	});

	// The bug: four branches enqueued 1-2-3-4 completed 2-4-1-3, so the
	// completion-ordered carousel swiped in an order the grid never showed.
	it('re-seats the grid’s members into completion order’s slots', () => {
		const carousel = ['m2', 'm4', 'm1', 'm3'].map(ref);
		const grid = ['m1', 'm2', 'm3', 'm4'];
		expect(applyDisplayOrder(carousel, grid).map((x) => x.id)).toEqual(['m1', 'm2', 'm3', 'm4']);
	});

	it('leaves everything outside the grid exactly where it was', () => {
		// `old*` are earlier turns in the same conversation; only the four grid
		// members move, and only among the slots they already held.
		const carousel = ['oldA', 'm2', 'm4', 'oldB', 'm1', 'm3', 'oldC'].map(ref);
		expect(applyDisplayOrder(carousel, ['m1', 'm2', 'm3', 'm4']).map((x) => x.id)).toEqual([
			'oldA',
			'm1',
			'm2',
			'oldB',
			'm3',
			'm4',
			'oldC',
		]);
	});

	it('ignores grid members the carousel set predates', () => {
		// A branch that landed after the set was fetched: it has no slot to sit
		// in, and must not consume one belonging to another image.
		const carousel = ['m2', 'm1'].map(ref);
		expect(applyDisplayOrder(carousel, ['m1', 'm2', 'm3']).map((x) => x.id)).toEqual(['m1', 'm2']);
	});

	it('is a copy, not a mutation, and is inert with no grid', () => {
		const carousel = ['m2', 'm1'].map(ref);
		const out = applyDisplayOrder(carousel, []);
		expect(out).not.toBe(carousel);
		expect(out.map((x) => x.id)).toEqual(['m2', 'm1']);
		expect(carousel.map((x) => x.id)).toEqual(['m2', 'm1']);
	});
});

describe('dispatch-index placement', () => {
	const at = (branchId: string, dispatchIndex: number | null): FanoutColumn => ({
		branchId,
		dispatchIndex,
		modelId: 'bridge::a',
		modelKind: 'image',
		label: 'A',
		segments: [],
		status: 'done',
		queuedAhead: 0,
		progress: null,
		statusLabel: null,
		startedAt: null,
		inputMediaId: null,
		persisted: null,
		error: null,
		errorMessageId: null,
	});

	describe('nextDispatchIndex', () => {
		it('starts at 0 for a fresh grid (every turn fan-out)', () => {
			expect(nextDispatchIndex([])).toBe(0);
		});

		it('continues past what the anchor already holds (a second avatar round)', () => {
			expect(nextDispatchIndex([at('a', 0), at('b', 1)])).toBe(2);
		});

		it('ignores un-indexed columns, so seeded legacy portraits don’t hold it back', () => {
			expect(nextDispatchIndex([at('legacy', null), at('a', 0)])).toBe(1);
			expect(nextDispatchIndex([at('legacy', null)])).toBe(0);
		});
	});

	describe('rerollInsertIndex', () => {
		it('places a re-roll immediately after its source', () => {
			const cols = [at('a', 0), at('b', 1), at('c', 2)];
			expect(rerollInsertIndex(cols, cols[0])).toBe(1);
		});

		// The live mirror of the DB's (index, createdAt) sort: a run stays in the
		// order it was rolled, so live and recovered grids agree.
		it('places a second re-roll after the first, not between it and the source', () => {
			const cols = [at('a', 0), at('a-r1', 0), at('b', 1)];
			expect(rerollInsertIndex(cols, cols[0])).toBe(2);
			// Re-rolling the re-roll lands in the same place — same run, same index.
			expect(rerollInsertIndex(cols, cols[1])).toBe(2);
		});

		it('does not run past a neighbour that merely follows (different index)', () => {
			const cols = [at('a', 0), at('b', 1), at('b-r1', 1)];
			expect(rerollInsertIndex(cols, cols[0])).toBe(1);
		});

		it('puts an un-indexed source’s re-roll immediately after it', () => {
			// A seeded avatar portrait can't name a run — every other seed shares
			// its null, so scanning forward would jump the whole seeded block.
			const cols = [at('seed-1', null), at('seed-2', null), at('fresh', 0)];
			expect(rerollInsertIndex(cols, cols[0])).toBe(1);
		});

		it('appends when the source is gone from the grid', () => {
			const cols = [at('a', 0)];
			expect(rerollInsertIndex(cols, at('discarded', 5))).toBe(1);
		});
	});
});
