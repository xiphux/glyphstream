import { describe, expect, it } from 'vitest';
import {
	coerceToolPolicy,
	EMPTY_TOOL_POLICY,
	parseToolPolicy,
} from '#lib/server/scheduled/tool-policy.js';

describe('coerceToolPolicy', () => {
	it('keeps valid names, deduped and sorted', () => {
		expect(coerceToolPolicy({ allowed: ['b', 'a', 'a'], ask: ['c'], memoryWrites: true })).toEqual({
			allowed: ['a', 'b'],
			ask: ['c'],
			memoryWrites: true,
		});
	});

	it('reads a name in both lists as ask — the cautious one', () => {
		expect(coerceToolPolicy({ allowed: ['x', 'y'], ask: ['x'] })).toEqual({
			allowed: ['y'],
			ask: ['x'],
			memoryWrites: false,
		});
	});

	it('drops junk instead of failing', () => {
		expect(
			coerceToolPolicy({ allowed: [1, '', null, 'ok', 'x'.repeat(500)], ask: 'nope' }),
		).toEqual({ allowed: ['ok'], ask: [], memoryWrites: false });
		expect(coerceToolPolicy(null)).toEqual(EMPTY_TOOL_POLICY);
	});

	it('only a literal true enables memory writes', () => {
		expect(coerceToolPolicy({ memoryWrites: 'yes' }).memoryWrites).toBe(false);
	});

	it('reads a corrupt stored policy as the empty one', () => {
		expect(parseToolPolicy('{not json')).toEqual(EMPTY_TOOL_POLICY);
		expect(parseToolPolicy(null)).toEqual(EMPTY_TOOL_POLICY);
	});
});
