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

describe('toolPermitter', () => {
	it('permits named MCP tools, memory writes only on request, other built-ins always', async () => {
		const { toolPermitter } = await import('#lib/server/scheduled/tool-policy.js');
		const permit = toolPermitter({
			allowed: ['mcp__a__x'],
			ask: ['mcp__a__y'],
			memoryWrites: false,
		});
		expect(permit('mcp__a__x')).toBe(true);
		expect(permit('mcp__a__y')).toBe(true);
		expect(permit('mcp__a__z')).toBe(false);
		expect(permit('save_memory')).toBe(false);
		expect(permit('recall_memory')).toBe(true);
		expect(permit('web_search')).toBe(true);
	});

	it('names the memory tools that actually write', async () => {
		// Guard against a rename: every name in the set must be a registered
		// personalization tool, or the "no memory writes" default silently lapses.
		await import('#lib/server/tools/index.js');
		const { get } = await import('#lib/server/tools/registry.js');
		const { MEMORY_WRITE_TOOLS } = await import('#lib/server/scheduled/tool-policy.js');
		for (const name of MEMORY_WRITE_TOOLS) {
			expect(get(name)?.metadata?.category, name).toBe('personalization');
		}
	});
});
