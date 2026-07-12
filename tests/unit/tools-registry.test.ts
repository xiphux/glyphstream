import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
	_resetForTests,
	deferredToolCatalog,
	get,
	list,
	openaiToolDefinitions,
	register,
	resolveActivatedToolDefs,
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

/** A global deferred tool: metadata.deferred=true, no isAvailable override. */
function mkDeferred(name: string, description = 'deferred tool', category?: string): Tool {
	return {
		...mkTool(name, description),
		metadata: { deferred: true, category: category as never },
	};
}

/** A per-user deferred tool: deferred AND isAvailable:false (loaded on demand). */
function mkPerUserDeferred(name: string, category?: string): Tool {
	return { ...mkDeferred(name, 'per-user deferred', category), isAvailable: () => false };
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

	it('replaces on duplicate registration (HMR-friendly)', () => {
		// Vite re-evaluates the tools/index.ts module on edit and re-runs
		// every built-in's register() — throwing would force a full
		// restart on each save. Replacing keeps the registry idempotent
		// without leaving stale duplicates around. Production still calls
		// register() exactly once per tool at startup, so the replace
		// path only matters for dev-mode HMR.
		const first = mkTool('dup', 'first description');
		const second = mkTool('dup', 'second description');
		register(first);
		register(second);
		expect(get('dup')?.definition.function.description).toBe('second description');
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

	it('openaiToolDefinitions drops deferred tools', () => {
		register(mkTool('visible'));
		register(mkDeferred('hidden'));
		expect(openaiToolDefinitions().map((d) => d.function.name)).toEqual(['visible']);
	});
});

describe('deferredToolCatalog', () => {
	it('returns only deferred tools, as {name, description, category}', () => {
		register(mkTool('visible'));
		register(mkDeferred('gh_create_issue', 'Create a GitHub issue', 'mcp:github'));
		expect(deferredToolCatalog()).toEqual([
			{ name: 'gh_create_issue', description: 'Create a GitHub issue', category: 'mcp:github' },
		]);
	});

	it('respects excludeCategories (the per-conversation opt-out)', () => {
		register(mkDeferred('gh_x', 'gh', 'mcp:github'));
		register(mkDeferred('sl_x', 'slack', 'mcp:slack'));
		const names = deferredToolCatalog({ excludeCategories: ['mcp:github'] }).map((t) => t.name);
		expect(names).toEqual(['sl_x']);
	});

	it('excludes per-user deferred tools (isAvailable:false) — they come via the per-user path', () => {
		register(mkDeferred('global_deferred'));
		register(mkPerUserDeferred('peruser_deferred'));
		expect(deferredToolCatalog().map((t) => t.name)).toEqual(['global_deferred']);
	});
});

describe('resolveActivatedToolDefs', () => {
	it('resolves names to full definitions, deduplicates, skips unknowns', () => {
		const a = mkDeferred('a');
		const b = mkDeferred('b');
		register(a);
		register(b);
		const defs = resolveActivatedToolDefs(['a', 'b', 'a', 'gone']);
		expect(defs).toEqual([a.definition, b.definition]);
	});

	it('loads per-user deferred tools despite isAvailable:false (loaded on demand)', () => {
		const t = mkPerUserDeferred('peruser');
		register(t);
		expect(resolveActivatedToolDefs(['peruser'])).toEqual([t.definition]);
	});

	it('honors excludeCategories — a disabled category is not re-loaded', () => {
		register(mkDeferred('gh_x', 'gh', 'mcp:github'));
		const defs = resolveActivatedToolDefs(['gh_x'], { excludeCategories: ['mcp:github'] });
		expect(defs).toEqual([]);
	});
});

describe('openaiToolDefinitions — deterministic ordering', () => {
	beforeEach(() => _resetForTests());
	afterEach(() => _resetForTests());

	it('emits tools in name order, not registration order', () => {
		// Registration order is a function of TIMING, not of anything a user did:
		// built-ins register lazily on the first chat request, while bootstrapMcp()
		// registers global MCP tools from a hook fired at module eval — so whichever
		// wins the race at boot lands first in the Map. An admin retrying a global
		// server that failed at startup appends its tools to the tail, mid-process.
		// Either way the SAME logical tool set serializes to different bytes, which
		// re-prefills every conversation on the box for nothing.
		register(mkTool('zebra'));
		register(mkTool('alpha'));
		register(mkTool('mike'));

		expect(openaiToolDefinitions().map((d) => d.function.name)).toEqual(['alpha', 'mike', 'zebra']);
	});

	it('is invariant to the order the same tools were registered in', () => {
		// The property that actually matters: two processes that registered the same
		// tools in different orders must produce byte-identical tools[].
		register(mkTool('web_search'));
		register(mkTool('run_python'));
		register(mkTool('get_current_time'));
		const bootA = JSON.stringify(openaiToolDefinitions());

		_resetForTests();
		register(mkTool('get_current_time'));
		register(mkTool('web_search'));
		register(mkTool('run_python'));
		const bootB = JSON.stringify(openaiToolDefinitions());

		expect(bootA).toBe(bootB);
	});

	it('a late registration lands in its sorted position, not at the tail', () => {
		// e.g. an admin hitting "retry" on a global MCP server that failed at boot.
		register(mkTool('alpha'));
		register(mkTool('zebra'));
		register(mkTool('mike')); // arrives late

		expect(openaiToolDefinitions().map((d) => d.function.name)).toEqual(['alpha', 'mike', 'zebra']);
	});
});
