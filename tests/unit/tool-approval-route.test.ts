/**
 * Route-handler tests for POST /api/conversations/[id]/tool-approval.
 *
 * The approval resume is the send route's anti-drift twin: both assemble the
 * upstream payload through `buildChatToolContext`, and a resumed turn must put
 * the same `tools[]` on the wire the send path would. Real DB (conversation,
 * branch, pending tool_result rewrite); mocked edges are the endpoint registry,
 * the tool context, tool execution and the relay, whose `requestBody` is what
 * these tests read.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDb, closeTestDb, type TestDB } from './_helpers/test-db';
import { seedUser } from './_helpers/seed';
import type { LoadedEndpoint } from '$lib/server/endpoints/config';
import type { OpenAIToolDefinition } from '$lib/server/tools/types';

const ENDPOINT: LoadedEndpoint = {
	id: 'mock',
	displayName: 'Mock',
	baseUrl: 'http://localhost/v1',
	apiKey: null,
	requestTimeoutSeconds: 120,
	providerQuirk: 'passthrough',
	groupBy: 'endpoint',
	supportsTools: true,
	maxConcurrent: Infinity,
	resourceGroup: 'mock',
	resourceGroupMaxConcurrent: Infinity,
	release: null,
	contextWindow: null,
	modelContextWindows: {},
	modelPromptStyles: {},
	modelPromptHints: {},
};

type RelayOpts = {
	requestBody: { tools?: OpenAIToolDefinition[] };
	rebuildRequestBody: (o?: { activatedToolNames?: string[] }) => Promise<{
		tools?: OpenAIToolDefinition[];
	}>;
};

const mocks = vi.hoisted(() => ({
	testDb: null as unknown as TestDB,
	toolDefs: [] as unknown[],
	relayCalls: [] as unknown[],
}));

vi.mock('$lib/server/db/client', () => ({
	getDb: () => mocks.testDb,
	closeDb: () => {},
}));
vi.mock('$lib/server/endpoints/registry', () => ({
	getEndpoint: () => ENDPOINT,
}));
vi.mock('$lib/server/endpoints/list-models', () => ({
	listAllModels: async () => [],
}));
vi.mock('$lib/server/mcp/bootstrap', () => ({
	awaitMcpReady: async () => {},
}));
vi.mock('$lib/server/chat/tool-context', () => ({
	buildChatToolContext: async () => ({
		systemPrompt: null,
		toolDefs: mocks.toolDefs,
		needsApproval: () => false,
		unavailableMcpServers: [],
	}),
	augmentRequestForCanvas: async (body: unknown) => body,
}));
vi.mock('$lib/server/chat/persona-context', () => ({
	composePersonaPrompt: () => null,
}));
vi.mock('$lib/server/streaming/tool-execution', () => ({
	executeOneToolCall: async () => ({
		execution: { content: '{"ok":true}', isError: false },
		mediaParts: [],
	}),
}));
vi.mock('$lib/server/streaming/relay', () => ({
	startStreamingRelay: async (opts: unknown) => {
		mocks.relayCalls.push(opts);
		return new ReadableStream();
	},
}));

import { POST } from '../../src/routes/api/conversations/[id]/tool-approval/+server';
import { createConversation } from '$lib/server/db/queries/conversations';
import { appendMessage } from '$lib/server/db/queries/messages';
import { resetInFlight } from '$lib/server/streaming/in-flight';

function toolDef(name: string, description = name): OpenAIToolDefinition {
	return {
		type: 'function',
		function: { name, description, parameters: { type: 'object', properties: {} } },
	};
}

/** user → assistant(tool_call) → tool(pending_approval). */
function seedPendingApproval(): { conversationId: string; userId: string } {
	const u = seedUser();
	const conv = createConversation({
		userId: u.id,
		endpointId: 'mock',
		modelId: 'mock::mock-chat',
		modelKind: 'chat',
	});
	let parent: string | null = null;
	const add = (
		role: 'user' | 'assistant' | 'tool',
		parts: Parameters<typeof appendMessage>[0]['parts'],
	) => {
		const m = appendMessage({
			conversationId: conv.id,
			parentMessageId: parent,
			role,
			parts,
			contentHtml: null,
			reasoningText: null,
			finishReason: null,
			modelUsed: null,
			tokensIn: null,
			tokensOut: null,
		});
		parent = m.id;
		return m;
	};
	add('user', [{ type: 'text', text: 'look it up' }]);
	add('assistant', [
		{ type: 'tool_call', toolCallId: 'call_1', toolName: 'mcp__srv__lookup', arguments: '{}' },
	]);
	add('tool', [
		{ type: 'tool_result', toolCallId: 'call_1', result: '', status: 'pending_approval' },
	]);
	return { conversationId: conv.id, userId: u.id };
}

function approve(conversationId: string, userId: string) {
	const url = new URL(`http://x/api/conversations/${conversationId}/tool-approval`);
	const request = new Request(url, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ decisions: [{ toolCallId: 'call_1', action: 'allow' }] }),
	});
	return POST({
		locals: { user: { id: userId } },
		params: { id: conversationId },
		request,
		url,
	} as unknown as Parameters<typeof POST>[0]);
}

const names = (tools: OpenAIToolDefinition[] | undefined) =>
	(tools ?? []).map((t) => t.function.name);

beforeEach(() => {
	mocks.testDb = createTestDb();
	mocks.toolDefs = [];
	mocks.relayCalls = [];
});
afterEach(() => {
	resetInFlight();
	closeTestDb();
});

describe('POST /tool-approval — tools[] matches the send path', () => {
	it('dedupes a base/activation-seed collision on the first resumed request', async () => {
		// The collision dedupeToolDefs exists for: a tool activated on an earlier
		// turn whose server has since stopped deferring it, so the shared context
		// advertises it twice. The send route dedupes at assignment; so must this.
		mocks.toolDefs = [
			toolDef('mcp__srv__lookup'),
			toolDef('web_search'),
			toolDef('mcp__srv__lookup'),
		];
		const { conversationId, userId } = seedPendingApproval();

		const res = await approve(conversationId, userId);

		expect(res.status).toBe(200);
		const [opts] = mocks.relayCalls as RelayOpts[];
		expect(names(opts.requestBody.tools)).toEqual(['mcp__srv__lookup', 'web_search']);
	});

	it('keeps the rebuilt per-iteration request deduped too', async () => {
		mocks.toolDefs = [toolDef('web_search'), toolDef('web_search')];
		const { conversationId, userId } = seedPendingApproval();

		await approve(conversationId, userId);

		const [opts] = mocks.relayCalls as RelayOpts[];
		const rebuilt = await opts.rebuildRequestBody();
		expect(names(rebuilt.tools)).toEqual(['web_search']);
	});
});
