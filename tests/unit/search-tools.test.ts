import { beforeEach, describe, expect, it, vi } from 'vitest';

// Default: no embeddings configured → BM25-only, no network. (Same seams as the
// fetch_url test.)
const loadEmbeddingsConfigMock = vi.hoisted(() => vi.fn());
const getEndpointMock = vi.hoisted(() => vi.fn());
const embeddingsMock = vi.hoisted(() => vi.fn());
const buildUserDeferredToolCatalogMock = vi.hoisted(() => vi.fn());
const mcpRegistryMock = vi.hoisted(() => ({
	listServerCatalog: vi.fn(),
	getUserServerStates: vi.fn(),
	getMcpServerCfg: vi.fn(),
}));

vi.mock('$lib/server/endpoints/config', async (orig) => ({
	...(await orig<typeof import('$lib/server/endpoints/config')>()),
	loadEmbeddingsConfig: loadEmbeddingsConfigMock,
}));
vi.mock('$lib/server/endpoints/registry', async (orig) => ({
	...(await orig<typeof import('$lib/server/endpoints/registry')>()),
	getEndpoint: getEndpointMock,
}));
vi.mock('$lib/server/endpoints/client', async (orig) => ({
	...(await orig<typeof import('$lib/server/endpoints/client')>()),
	embeddings: embeddingsMock,
}));
// Per-user deferred catalog hits the DB / live connections — stub it.
vi.mock('$lib/server/mcp/tool-bridge', () => ({
	buildUserDeferredToolCatalog: buildUserDeferredToolCatalogMock,
}));
// tool-search-context's only mcp/registry surface.
vi.mock('$lib/server/mcp/registry', () => mcpRegistryMock);

import {
	searchToolsTool,
	toolSearchEmbeddingConfig,
	TOOL_SEARCH_EMBED_TIMEOUT_SECONDS,
} from '$lib/server/tools/search-tools';
import { _resetEmbeddingsConfigCacheForTests } from '$lib/server/retrieval/embeddings-config';
import {
	appendToolSearchHint,
	buildToolSearchRequestContext,
	collectActivatedToolNames,
} from '$lib/server/chat/tool-search-context';
import { _resetForTests, register } from '$lib/server/tools/registry';
import type { ToolContext } from '$lib/server/tools/types';
import type { ChatMessage } from '$lib/types/api';

function registerDeferred(
	name: string,
	description: string,
	category: string,
	displayLabel?: string,
): void {
	register({
		definition: {
			type: 'function',
			function: {
				name,
				description,
				parameters: { type: 'object', properties: {}, additionalProperties: false },
			},
		},
		metadata: { deferred: true, category: category as never, displayLabel },
		execute: () => ({ content: `ran ${name}` }),
	});
}

function ctx(disabledFeatures: string[] = []): ToolContext {
	return {
		userId: 'u1',
		conversationId: 'c1',
		signal: new AbortController().signal,
		disabledFeatures: disabledFeatures as never,
	};
}

beforeEach(() => {
	_resetForTests();
	_resetEmbeddingsConfigCacheForTests();
	loadEmbeddingsConfigMock.mockReturnValue(null);
	getEndpointMock.mockReturnValue(undefined);
	embeddingsMock.mockReset();
	buildUserDeferredToolCatalogMock.mockResolvedValue([]);
	mcpRegistryMock.listServerCatalog.mockReturnValue([]);
	mcpRegistryMock.getUserServerStates.mockResolvedValue([]);
	mcpRegistryMock.getMcpServerCfg.mockReturnValue(undefined);
});

describe('search_tools execute', () => {
	it('returns ranked matches and activates them (BM25-only)', async () => {
		registerDeferred('mcp__gh__create_issue', 'Create an issue on GitHub', 'mcp:gh');
		registerDeferred('mcp__gh__view_issue', 'View an issue', 'mcp:gh');
		registerDeferred('mcp__cal__create_event', 'Schedule a calendar event', 'mcp:cal');

		const res = await searchToolsTool.execute({ query: 'issue' }, ctx());
		expect(res.isError).toBeFalsy();
		expect(res.activatedToolNames).toContain('mcp__gh__create_issue');
		expect(res.activatedToolNames).toContain('mcp__gh__view_issue');
		// no lexical overlap with "issue".
		expect(res.activatedToolNames).not.toContain('mcp__cal__create_event');
		expect(res.content).toContain('mcp__gh__create_issue');
	});

	it("includes the caller's per-user deferred tools in the catalog", async () => {
		buildUserDeferredToolCatalogMock.mockResolvedValue([
			{ name: 'mcp__mail__send_email', description: 'Send an email message', category: 'mcp:mail' },
		]);
		const res = await searchToolsTool.execute({ query: 'send email' }, ctx());
		expect(res.activatedToolNames).toContain('mcp__mail__send_email');
		expect(buildUserDeferredToolCatalogMock).toHaveBeenCalledWith('u1', {
			excludeCategories: [],
		});
	});

	it('rejects an empty query with a recoverable error', async () => {
		registerDeferred('mcp__gh__create_issue', 'Create an issue', 'mcp:gh');
		expect((await searchToolsTool.execute({ query: '   ' }, ctx())).isError).toBe(true);
		expect((await searchToolsTool.execute({}, ctx())).isError).toBe(true);
	});

	it('returns a recoverable (non-error) result with no activations when nothing matches', async () => {
		registerDeferred('mcp__gh__create_issue', 'Create an issue', 'mcp:gh');
		const res = await searchToolsTool.execute({ query: 'zzz frobnicate' }, ctx());
		expect(res.isError).toBeFalsy();
		expect(res.activatedToolNames).toEqual([]);
		expect(res.content).toContain('No tools matched');
	});

	it('honors the per-conversation category opt-out at execute time', async () => {
		registerDeferred('mcp__gh__create_issue', 'Create an issue', 'mcp:gh');
		const res = await searchToolsTool.execute({ query: 'issue' }, ctx(['mcp:gh']));
		expect(res.activatedToolNames).toEqual([]);
		expect(res.content).toContain('No additional tools');
	});
});

describe('buildToolSearchRequestContext', () => {
	it('omits search_tools when there are no deferred tools', async () => {
		// A non-deferred tool is registered, but deferredToolCatalog returns
		// nothing and the per-user catalog is empty → omit-when-empty.
		register({
			definition: {
				type: 'function',
				function: { name: 'mcp__fs__read', description: 'Read', parameters: { type: 'object' } },
			},
			metadata: { category: 'mcp:fs' as never },
			execute: () => ({ content: 'x' }),
		});
		const r = await buildToolSearchRequestContext('u1', []);
		expect(r.def).toBeNull();
		expect(r.hint).toBeNull();
	});

	it('advertises search_tools + a hint listing global deferred tool names by server', async () => {
		registerDeferred('mcp__github__create_issue', 'Create an issue', 'mcp:github', 'create_issue');
		registerDeferred('mcp__github__list_issues', 'List issues', 'mcp:github', 'list_issues');
		mcpRegistryMock.getMcpServerCfg.mockImplementation((id: string) =>
			id === 'github' ? { displayName: 'GitHub', deferTools: true, auth: 'global' } : undefined,
		);
		const r = await buildToolSearchRequestContext('u1', []);
		expect(r.def?.function.name).toBe('search_tools');
		// Names listed (no descriptions), grouped under the server display name.
		expect(r.hint).toContain('GitHub: create_issue, list_issues');
		expect(r.hint).not.toContain('Create an issue');
	});

	it('omits a deferred server whose category is disabled for the conversation', async () => {
		registerDeferred('mcp__github__create_issue', 'Create an issue', 'mcp:github', 'create_issue');
		const r = await buildToolSearchRequestContext('u1', ['mcp:github']);
		expect(r.def).toBeNull();
	});

	it("lists the caller's connected per-user deferred tools", async () => {
		buildUserDeferredToolCatalogMock.mockResolvedValue([
			{
				name: 'mcp__mail__send_email',
				description: 'Send an email',
				category: 'mcp:mail',
				displayLabel: 'send_email',
			},
		]);
		mcpRegistryMock.getMcpServerCfg.mockImplementation((id: string) =>
			id === 'mail' ? { displayName: 'Mail', deferTools: true, auth: 'per_user' } : undefined,
		);
		const r = await buildToolSearchRequestContext('u1', []);
		expect(r.def?.function.name).toBe('search_tools');
		expect(r.hint).toContain('Mail: send_email');
	});

	it('falls back to the server id when no display name is configured', async () => {
		registerDeferred('mcp__gh__x', 'X', 'mcp:gh', 'x');
		mcpRegistryMock.getMcpServerCfg.mockReturnValue(undefined);
		const r = await buildToolSearchRequestContext('u1', []);
		expect(r.hint).toContain('gh: x');
	});
});

describe('toolSearchEmbeddingConfig', () => {
	const embCfg = (timeoutSeconds: number) => ({
		endpointId: 'e',
		modelId: 'm',
		timeoutSeconds,
		queryPrefix: '',
		documentPrefix: '',
		maxInputTokens: 512,
	});
	const fakeEndpoint = { id: 'e', baseUrl: 'http://e', apiKey: null };

	it('returns undefined when embeddings are not configured (BM25-only)', () => {
		loadEmbeddingsConfigMock.mockReturnValue(null);
		expect(toolSearchEmbeddingConfig()).toBeUndefined();
	});

	it('caps the embed timeout so a slow/down endpoint falls back to BM25 fast', () => {
		loadEmbeddingsConfigMock.mockReturnValue(embCfg(30));
		getEndpointMock.mockReturnValue(fakeEndpoint);
		expect(toolSearchEmbeddingConfig()?.timeoutSeconds).toBe(TOOL_SEARCH_EMBED_TIMEOUT_SECONDS);
	});

	it('respects a configured timeout shorter than the cap', () => {
		loadEmbeddingsConfigMock.mockReturnValue(embCfg(2));
		getEndpointMock.mockReturnValue(fakeEndpoint);
		expect(toolSearchEmbeddingConfig()?.timeoutSeconds).toBe(2);
	});
});

describe('appendToolSearchHint', () => {
	it('joins base + hint, drops nulls, returns null when both absent', () => {
		expect(appendToolSearchHint('sys', 'hint')).toBe('sys\n\nhint');
		expect(appendToolSearchHint(null, 'hint')).toBe('hint');
		expect(appendToolSearchHint('sys', null)).toBe('sys');
		expect(appendToolSearchHint(null, null)).toBeNull();
	});
});

describe('collectActivatedToolNames', () => {
	function msg(parts: ChatMessage['parts']): ChatMessage {
		return { parts } as ChatMessage;
	}

	it('unions activatedToolNames across tool_result parts on the branch', () => {
		const branch = [
			msg([
				{ type: 'tool_result', toolCallId: 'a', result: 'x', activatedToolNames: ['t1', 't2'] },
			]),
			msg([{ type: 'text', text: 'hi' }]),
			msg([
				{ type: 'tool_result', toolCallId: 'b', result: 'y', activatedToolNames: ['t2', 't3'] },
			]),
			msg([{ type: 'tool_result', toolCallId: 'c', result: 'z' }]),
		];
		expect(collectActivatedToolNames(branch).sort()).toEqual(['t1', 't2', 't3']);
	});

	it('returns [] when nothing was activated', () => {
		expect(collectActivatedToolNames([msg([{ type: 'text', text: 'hi' }])])).toEqual([]);
	});
});
