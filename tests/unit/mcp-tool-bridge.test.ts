import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
	callMcpTool: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
}));

vi.mock('$lib/server/mcp/registry', async () => {
	const actual = await vi.importActual<typeof import('$lib/server/mcp/registry')>(
		'$lib/server/mcp/registry',
	);
	return {
		...actual,
		callMcpTool: (...args: unknown[]) => mocks.callMcpTool(...args),
	};
});

import { buildRegisteredName, flattenMcpResult, mcpToolFor } from '$lib/server/mcp/tool-bridge';
import type { LoadedMcpServer } from '$lib/server/mcp/config';

const FAKE_SERVER: LoadedMcpServer = {
	id: 'fs',
	displayName: 'Filesystem',
	transport: 'stdio',
	auth: 'global',
	command: 'x',
	args: [],
	env: {},
	timeoutSeconds: 30,
	idleTimeoutSeconds: 900,
};

beforeEach(() => {
	mocks.callMcpTool.mockReset();
});

afterEach(() => {
	mocks.callMcpTool.mockReset();
});

describe('buildRegisteredName', () => {
	it('namespaces with mcp__<server>__<tool>', () => {
		expect(buildRegisteredName('fs', 'read_file')).toBe('mcp__fs__read_file');
	});

	it('sanitizes invalid characters to underscores', () => {
		expect(buildRegisteredName('fs', 'read.file/special')).toBe('mcp__fs__read_file_special');
	});

	it('truncates the tool-name suffix when the combined string exceeds 64 chars', () => {
		const longName = 'x'.repeat(100);
		const result = buildRegisteredName('fs', longName);
		expect(result.length).toBeLessThanOrEqual(64);
		expect(result.startsWith('mcp__fs__')).toBe(true);
	});
});

describe('flattenMcpResult', () => {
	it('joins text blocks with newlines', () => {
		const out = flattenMcpResult({
			content: [
				{ type: 'text', text: 'first' },
				{ type: 'text', text: 'second' },
			],
			isError: false,
		});
		expect(out).toEqual({ content: 'first\nsecond', isError: false });
	});

	it('replaces non-text blocks with a placeholder note', () => {
		const out = flattenMcpResult({
			content: [
				{ type: 'text', text: 'see image' },
				{ type: 'image', data: 'base64...', mimeType: 'image/png' },
			],
			isError: false,
		});
		expect(out.content).toBe('see image\n[non-text content omitted in v1]');
		expect(out.isError).toBe(false);
	});

	it('propagates isError = true', () => {
		const out = flattenMcpResult({
			content: [{ type: 'text', text: 'something went wrong' }],
			isError: true,
		});
		expect(out.isError).toBe(true);
		expect(out.content).toBe('something went wrong');
	});

	it('returns empty content when there are no text blocks and no non-text either', () => {
		const out = flattenMcpResult({ content: [], isError: false });
		expect(out.content).toBe('');
	});
});

describe('mcpToolFor execute()', () => {
	it('proxies the call through callMcpTool with the original (un-namespaced) tool name', async () => {
		mocks.callMcpTool.mockResolvedValue({
			content: [{ type: 'text', text: 'ok' }],
			isError: false,
		});
		const tool = mcpToolFor(FAKE_SERVER, {
			name: 'read_file',
			description: 'Read a file',
			inputSchema: { type: 'object', properties: { path: { type: 'string' } } },
		});
		const ac = new AbortController();
		const result = await tool.execute(
			{ path: '/tmp/x' },
			{
				userId: 'u1',
				conversationId: 'c1',
				signal: ac.signal,
				disabledFeatures: [],
			},
		);
		expect(mocks.callMcpTool).toHaveBeenCalledWith(
			'fs',
			'u1',
			'read_file',
			{ path: '/tmp/x' },
			ac.signal,
		);
		expect(result).toEqual({ content: 'ok', isError: false });
	});

	it('captures thrown errors and returns isError instead of throwing', async () => {
		mocks.callMcpTool.mockRejectedValue(new Error('reconnect failed'));
		const tool = mcpToolFor(FAKE_SERVER, {
			name: 'read_file',
			description: '',
			inputSchema: { type: 'object' },
		});
		const ac = new AbortController();
		const result = await tool.execute(
			{},
			{
				userId: 'u1',
				conversationId: 'c1',
				signal: ac.signal,
				disabledFeatures: [],
			},
		);
		expect(result.isError).toBe(true);
		expect(result.content).toContain('reconnect failed');
	});

	it('declares the mcp:<server-id> category and uses the original name as display label', () => {
		const tool = mcpToolFor(FAKE_SERVER, {
			name: 'list_directory',
			description: 'List entries',
			inputSchema: { type: 'object' },
		});
		expect(tool.metadata?.category).toBe('mcp:fs');
		expect(tool.metadata?.displayLabel).toBe('list_directory');
		expect(tool.definition.function.name).toBe('mcp__fs__list_directory');
	});

	it('normalizes a missing or primitive inputSchema to an empty object schema', () => {
		const tool = mcpToolFor(FAKE_SERVER, {
			name: 'do_thing',
			description: '',
			inputSchema: null as unknown as Record<string, unknown>,
		});
		expect(tool.definition.function.parameters).toEqual({
			type: 'object',
			properties: {},
			additionalProperties: true,
		});
	});

	it('falls back to a generic description when the MCP server omits one', () => {
		const tool = mcpToolFor(FAKE_SERVER, {
			name: 'no_desc',
			description: '',
			inputSchema: { type: 'object' },
		});
		expect(tool.definition.function.description).toContain('Filesystem');
	});
});
