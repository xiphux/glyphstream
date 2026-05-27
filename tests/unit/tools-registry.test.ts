import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
	_resetForTests,
	get,
	list,
	openaiToolDefinitions,
	register
} from '$lib/server/tools/registry';
import type { Tool } from '$lib/server/tools/types';

function mkTool(name: string, description = 'test tool'): Tool {
	return {
		definition: {
			type: 'function',
			function: {
				name,
				description,
				parameters: { type: 'object', properties: {}, additionalProperties: false }
			}
		},
		execute: () => ({ content: `ran ${name}` })
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
});
