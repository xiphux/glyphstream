import { describe, expect, it } from 'vitest';
import { parseConsolidation, renderMemories } from '$lib/server/memory/consolidation';
import { MEMORY_MAX_CONTENT_CHARS } from '$lib/server/memory/limits';

const IDS = new Set(['a', 'b', 'c']);

function json(ops: unknown): string {
	return JSON.stringify({ operations: ops });
}

describe('parseConsolidation', () => {
	it('accepts well-formed ops', () => {
		const ops = parseConsolidation(
			json([
				{ type: 'merge', ids: ['a', 'b'], content: 'merged fact', topic: 'Topic' },
				{ type: 'reword', id: 'c', content: 'reworded', topic: 'T' },
			]),
			IDS,
		);
		expect(ops).toEqual([
			{ type: 'merge', ids: ['a', 'b'], content: 'merged fact', topic: 'Topic' },
			{ type: 'reword', id: 'c', content: 'reworded', topic: 'T' },
		]);
	});

	it('accepts retopic and prune', () => {
		const ops = parseConsolidation(
			json([
				{ type: 'retopic', id: 'a', topic: 'Better label' },
				{ type: 'prune', id: 'b', reason: 'fully superseded' },
			]),
			IDS,
		);
		expect(ops).toHaveLength(2);
		expect(ops[0]).toEqual({ type: 'retopic', id: 'a', topic: 'Better label' });
		expect(ops[1]).toEqual({ type: 'prune', id: 'b', reason: 'fully superseded' });
	});

	it('returns [] for malformed JSON', () => {
		expect(parseConsolidation('not json at all', IDS)).toEqual([]);
		expect(parseConsolidation('', IDS)).toEqual([]);
		expect(parseConsolidation('{"operations": "nope"}', IDS)).toEqual([]);
	});

	it('tolerates code fences / surrounding prose', () => {
		const wrapped =
			'Here you go:\n```json\n' + json([{ type: 'retopic', id: 'a', topic: 'X' }]) + '\n```';
		expect(parseConsolidation(wrapped, IDS)).toEqual([{ type: 'retopic', id: 'a', topic: 'X' }]);
	});

	it('drops ops referencing unknown ids', () => {
		expect(parseConsolidation(json([{ type: 'prune', id: 'zzz', reason: '' }]), IDS)).toEqual([]);
		expect(
			parseConsolidation(
				json([{ type: 'merge', ids: ['a', 'zzz'], content: 'x', topic: 't' }]),
				IDS,
			),
		).toEqual([]);
	});

	it('uses each id at most once across the batch (drops the second consumer)', () => {
		const ops = parseConsolidation(
			json([
				{ type: 'retopic', id: 'a', topic: 'First' },
				{ type: 'prune', id: 'a', reason: 'conflicts with the retopic above' },
			]),
			IDS,
		);
		expect(ops).toEqual([{ type: 'retopic', id: 'a', topic: 'First' }]);
	});

	it('drops a merge of fewer than two ids or with a repeated id', () => {
		expect(
			parseConsolidation(json([{ type: 'merge', ids: ['a'], content: 'x', topic: 't' }]), IDS),
		).toEqual([]);
		expect(
			parseConsolidation(json([{ type: 'merge', ids: ['a', 'a'], content: 'x', topic: 't' }]), IDS),
		).toEqual([]);
	});

	it('drops ops with blank or over-long content/topic', () => {
		expect(
			parseConsolidation(json([{ type: 'reword', id: 'a', content: '   ', topic: 't' }]), IDS),
		).toEqual([]);
		expect(
			parseConsolidation(
				json([
					{
						type: 'reword',
						id: 'a',
						content: 'x'.repeat(MEMORY_MAX_CONTENT_CHARS + 1),
						topic: 't',
					},
				]),
				IDS,
			),
		).toEqual([]);
		expect(
			parseConsolidation(json([{ type: 'retopic', id: 'a', topic: 'x'.repeat(81) }]), IDS),
		).toEqual([]);
	});

	it('keeps a richer multi-sentence reword within the content cap', () => {
		// The loosened prompt lets the pass distill to a short paragraph, not just a
		// bare sentence — such an op must survive validation.
		const rich =
			'Works at Globex; previously at Acme. Moved for the shift to backend Go work, ' +
			'which they prefer over the frontend role they held before.';
		expect(rich.length).toBeLessThanOrEqual(MEMORY_MAX_CONTENT_CHARS);
		expect(
			parseConsolidation(
				json([{ type: 'reword', id: 'a', content: rich, topic: 'Employer' }]),
				IDS,
			),
		).toEqual([{ type: 'reword', id: 'a', content: rich, topic: 'Employer' }]);
	});

	it('ignores unknown op types', () => {
		expect(parseConsolidation(json([{ type: 'explode', id: 'a' }]), IDS)).toEqual([]);
	});
});

describe('renderMemories', () => {
	it('wraps memories as [id] (topic) content lines', () => {
		const out = renderMemories([
			{ id: 'a', content: 'likes tea', topic: 'Beverage' },
			{ id: 'b', content: 'no label', topic: null },
		]);
		expect(out).toContain('<memories>');
		expect(out).toContain('[a] (Beverage) likes tea');
		expect(out).toContain('[b] (no topic) no label');
	});
});
