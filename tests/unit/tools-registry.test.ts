import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
	_resetForTests,
	get,
	list,
	openaiToolDefinitions,
	register,
} from '$lib/server/tools/registry';
import type { Tool } from '$lib/server/tools/types';

function mkTool(name: string, description = 'test tool'): Tool {
	return {
		definition: {
			type: 'function',
			function: {
				name,
				description,
				parameters: { type: 'object', properties: {}, additionalProperties: false },
			},
		},
		execute: () => ({ content: `ran ${name}` }),
	};
}

beforeEach(() => {
	_resetForTests();
});

afterEach(() => {
	_resetForTests();
});

describe('tool registry', () => {
	it('registers a tool and retrieves it by name', () => {
		const t = mkTool('echo');
		register(t);
		expect(get('echo')).toBe(t);
	});

	it('returns undefined for unknown names', () => {
		expect(get('nope')).toBeUndefined();
	});

	it('lists tools in insertion order', () => {
		const a = mkTool('a');
		const b = mkTool('b');
		const c = mkTool('c');
		register(a);
		register(b);
		register(c);
		expect(list()).toEqual([a, b, c]);
	});

	it('throws on duplicate registration', () => {
		register(mkTool('dup'));
		expect(() => register(mkTool('dup'))).toThrow(/already registered/);
	});

	it('openaiToolDefinitions returns just the definitions', () => {
		const a = mkTool('a', 'A description');
		const b = mkTool('b', 'B description');
		register(a);
		register(b);
		const defs = openaiToolDefinitions();
		expect(defs).toHaveLength(2);
		expect(defs[0]).toEqual(a.definition);
		expect(defs[1]).toEqual(b.definition);
	});

	it('openaiToolDefinitions is empty when no tools are registered', () => {
		expect(openaiToolDefinitions()).toEqual([]);
	});

	it('openaiToolDefinitions filters out tools whose isAvailable returns false', () => {
		const a = mkTool('always-on');
		const b: Tool = { ...mkTool('gated'), isAvailable: () => false };
		const c: Tool = { ...mkTool('explicitly-on'), isAvailable: () => true };
		register(a);
		register(b);
		register(c);
		const defs = openaiToolDefinitions();
		expect(defs.map((d) => d.function.name)).toEqual(['always-on', 'explicitly-on']);
	});

	it('list() returns gated tools too — only openaiToolDefinitions filters', () => {
		const gated: Tool = { ...mkTool('gated'), isAvailable: () => false };
		register(gated);
		expect(list()).toEqual([gated]);
		expect(get('gated')).toBe(gated);
		expect(openaiToolDefinitions()).toEqual([]);
	});

	it('excludeCategories drops tools whose metadata.category matches', () => {
		const uncategorized = mkTool('clock');
		const web1: Tool = { ...mkTool('search'), metadata: { category: 'web' } };
		const web2: Tool = { ...mkTool('fetch'), metadata: { category: 'web' } };
		register(uncategorized);
		register(web1);
		register(web2);
		const names = openaiToolDefinitions({ excludeCategories: ['web'] }).map((d) => d.function.name);
		expect(names).toEqual(['clock']);
	});

	it('excludeCategories: [] behaves the same as no option (back-compat)', () => {
		const a = mkTool('a');
		const b: Tool = { ...mkTool('b'), metadata: { category: 'web' } };
		register(a);
		register(b);
		expect(openaiToolDefinitions({ excludeCategories: [] })).toEqual(openaiToolDefinitions());
	});

	it('excludeCategories leaves tools without a category alone', () => {
		const a = mkTool('a');
		register(a);
		expect(openaiToolDefinitions({ excludeCategories: ['web', 'memory'] })).toEqual([a.definition]);
	});

	it('isAvailable + excludeCategories filters compose', () => {
		const ok: Tool = { ...mkTool('ok'), metadata: { category: 'web' } };
		const gatedAvail: Tool = {
			...mkTool('gated-avail'),
			metadata: { category: 'web' },
			isAvailable: () => false,
		};
		// 'memory' is a stand-in for a future category that isn't 'web' —
		// the filter should treat it as distinct regardless of whether it's
		// in FEATURE_CATEGORIES yet.
		const otherCat: Tool = {
			...mkTool('other'),
			metadata: { category: 'memory' as never },
		};
		register(ok);
		register(gatedAvail);
		register(otherCat);
		const names = openaiToolDefinitions({ excludeCategories: ['web'] }).map((d) => d.function.name);
		// 'ok' excluded by category, 'gated-avail' excluded by both, 'other' survives.
		expect(names).toEqual(['other']);
	});
});
