/**
 * Characterization tests for buildChatToolContext — the shared per-request tool
 * assembly extracted from the /messages and /tool-approval handlers. These lock
 * the assembly ORDER, the supportsTools gating, the single per-user-state
 * resolution threaded through both consumers, and the MCP approval gate, so the
 * two handlers can't drift after the dedupe. The data-producing dependencies are
 * mocked; the pure folding glue (appendSkillsCatalog / appendToolSearchHint /
 * collectActivatedToolNames) runs for real.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OpenAIToolDefinition } from '$lib/server/tools/types';
import type { ChatMessage } from '$lib/types/api';

const def = (name: string): OpenAIToolDefinition => ({
	type: 'function',
	function: { name, description: '', parameters: { type: 'object' } },
});

const mocks = vi.hoisted(() => ({
	awaitMcpReady: vi.fn(async () => {}),
	getUserServerStates: vi.fn(async (): Promise<unknown[]> => []),
	buildUserMcpToolDefinitions: vi.fn(async (): Promise<OpenAIToolDefinition[]> => []),
	openaiToolDefinitions: vi.fn((): OpenAIToolDefinition[] => []),
	resolveActivatedToolDefs: vi.fn((): OpenAIToolDefinition[] => []),
	buildSkillsRequestContext: vi.fn(() => ({
		catalog: null as string | null,
		toolDefs: [] as OpenAIToolDefinition[],
	})),
	buildToolSearchRequestContext: vi.fn(async () => ({
		def: null as OpenAIToolDefinition | null,
		hint: null as string | null,
	})),
	callOrder: [] as string[],
}));

vi.mock('$lib/server/mcp/bootstrap', () => ({
	awaitMcpReady: () => {
		mocks.callOrder.push('awaitMcpReady');
		return mocks.awaitMcpReady();
	},
}));
vi.mock('$lib/server/mcp/registry', () => ({
	getUserServerStates: (...a: unknown[]) => {
		mocks.callOrder.push('getUserServerStates');
		return mocks.getUserServerStates(...(a as []));
	},
}));
vi.mock('$lib/server/mcp/tool-bridge', () => ({
	buildUserMcpToolDefinitions: (...a: unknown[]) => mocks.buildUserMcpToolDefinitions(...(a as [])),
}));
vi.mock('$lib/server/tools', () => ({
	openaiToolDefinitions: (...a: unknown[]) => mocks.openaiToolDefinitions(...(a as [])),
	resolveActivatedToolDefs: (...a: unknown[]) => mocks.resolveActivatedToolDefs(...(a as [])),
}));
vi.mock('$lib/server/chat/skills-context', async (orig) => ({
	...(await orig<typeof import('$lib/server/chat/skills-context')>()),
	buildSkillsRequestContext: (...a: unknown[]) => mocks.buildSkillsRequestContext(...(a as [])),
}));
vi.mock('$lib/server/chat/tool-search-context', async (orig) => ({
	...(await orig<typeof import('$lib/server/chat/tool-search-context')>()),
	buildToolSearchRequestContext: (...a: unknown[]) =>
		mocks.buildToolSearchRequestContext(...(a as [])),
}));

import { buildChatToolContext } from '$lib/server/chat/tool-context';

beforeEach(() => {
	mocks.callOrder.length = 0;
	mocks.getUserServerStates.mockResolvedValue([]);
	mocks.buildUserMcpToolDefinitions.mockResolvedValue([]);
	mocks.openaiToolDefinitions.mockReturnValue([]);
	mocks.resolveActivatedToolDefs.mockReturnValue([]);
	mocks.buildSkillsRequestContext.mockReturnValue({ catalog: null, toolDefs: [] });
	mocks.buildToolSearchRequestContext.mockResolvedValue({ def: null, hint: null });
});
afterEach(() => vi.clearAllMocks());

const baseInput = {
	userId: 'u1',
	disabledFeatures: [] as const,
	supportsTools: true,
	baseSystemPrompt: 'BASE',
	branch: [] as ChatMessage[],
	trustedMcpTools: [] as string[],
};

describe('buildChatToolContext — supportsTools gating', () => {
	it('advertises no tools and passes the prompt through when tools are unsupported', async () => {
		const ctx = await buildChatToolContext({ ...baseInput, supportsTools: false });
		expect(ctx.toolDefs).toEqual([]);
		expect(ctx.systemPrompt).toBe('BASE');
		// No MCP work at all when tools are off.
		expect(mocks.awaitMcpReady).not.toHaveBeenCalled();
		expect(mocks.getUserServerStates).not.toHaveBeenCalled();
		expect(mocks.buildSkillsRequestContext).not.toHaveBeenCalled();
		expect(mocks.buildToolSearchRequestContext).not.toHaveBeenCalled();
	});

	it('awaits MCP readiness before resolving per-user server state', async () => {
		await buildChatToolContext(baseInput);
		expect(mocks.callOrder.indexOf('awaitMcpReady')).toBeLessThan(
			mocks.callOrder.indexOf('getUserServerStates'),
		);
	});
});

describe('buildChatToolContext — tool list assembly', () => {
	it('concatenates built-ins, skills, per-user MCP, search_tools, then the activation seed in order', async () => {
		mocks.openaiToolDefinitions.mockReturnValue([def('builtin')]);
		mocks.buildSkillsRequestContext.mockReturnValue({
			catalog: 'SKILLS',
			toolDefs: [def('activate_skill')],
		});
		mocks.buildUserMcpToolDefinitions.mockResolvedValue([def('mcp__x__do')]);
		mocks.buildToolSearchRequestContext.mockResolvedValue({
			def: def('search_tools'),
			hint: 'HINT',
		});
		mocks.resolveActivatedToolDefs.mockReturnValue([def('mcp__y__seeded')]);

		const ctx = await buildChatToolContext(baseInput);

		expect(ctx.toolDefs.map((d) => d.function.name)).toEqual([
			'builtin',
			'activate_skill',
			'mcp__x__do',
			'search_tools',
			'mcp__y__seeded',
		]);
	});

	it('omits search_tools when no deferred tools exist', async () => {
		mocks.openaiToolDefinitions.mockReturnValue([def('builtin')]);
		mocks.buildToolSearchRequestContext.mockResolvedValue({ def: null, hint: null });
		const ctx = await buildChatToolContext(baseInput);
		expect(ctx.toolDefs.map((d) => d.function.name)).toEqual(['builtin']);
	});

	it('does not dedupe — leaves that to the caller', async () => {
		mocks.openaiToolDefinitions.mockReturnValue([def('dup')]);
		mocks.resolveActivatedToolDefs.mockReturnValue([def('dup')]);
		const ctx = await buildChatToolContext(baseInput);
		expect(ctx.toolDefs.map((d) => d.function.name)).toEqual(['dup', 'dup']);
	});
});

describe('buildChatToolContext — single per-user-state resolution', () => {
	it('threads the same resolved server-state array into both the hint and the tool-def build', async () => {
		const states = [{ id: 's1' }];
		mocks.getUserServerStates.mockResolvedValue(states);
		await buildChatToolContext(baseInput);
		expect(mocks.getUserServerStates).toHaveBeenCalledTimes(1);
		expect(mocks.buildToolSearchRequestContext).toHaveBeenCalledWith('u1', [], states);
		expect(mocks.buildUserMcpToolDefinitions).toHaveBeenCalledWith('u1', {
			excludeCategories: [],
			states,
		});
	});
});

describe('buildChatToolContext — system prompt folding', () => {
	it('folds the skills catalog then the tool-search hint onto the base prompt', async () => {
		mocks.buildSkillsRequestContext.mockReturnValue({ catalog: 'SKILLS', toolDefs: [] });
		mocks.buildToolSearchRequestContext.mockResolvedValue({ def: null, hint: 'HINT' });
		const ctx = await buildChatToolContext(baseInput);
		expect(ctx.systemPrompt).toBe('BASE\n\nSKILLS\n\nHINT');
	});

	it('returns the base prompt unchanged when nothing is injected', async () => {
		const ctx = await buildChatToolContext(baseInput);
		expect(ctx.systemPrompt).toBe('BASE');
	});
});

describe('buildChatToolContext — needsApproval gate', () => {
	it('flags untrusted MCP tools, clears trusted ones, ignores built-ins', async () => {
		const ctx = await buildChatToolContext({
			...baseInput,
			trustedMcpTools: ['mcp__y__trusted'],
		});
		expect(ctx.needsApproval('mcp__x__untrusted')).toBe(true);
		expect(ctx.needsApproval('mcp__y__trusted')).toBe(false);
		expect(ctx.needsApproval('web_search')).toBe(false);
	});
});
