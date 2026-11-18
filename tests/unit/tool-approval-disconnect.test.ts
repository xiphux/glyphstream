/**
 * An approved tool runs under the conversation's in-flight controller, not the
 * approving request's signal: adapter-node aborts `request.signal` when the
 * client disconnects (a suspended PWA, a reload, a proxy's read timeout — the
 * handler sends nothing until the tool has finished), and a disconnect must not
 * stop work. Stop still does.
 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createTestDb, closeTestDb } from './_helpers/test-db';
import { seedUser } from './_helpers/seed';
import type { LoadedEndpoint } from '#lib/server/endpoints/config.js';

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

vi.mock('#lib/server/endpoints/registry.js', () => ({ getEndpoint: () => ENDPOINT }));
vi.mock('#lib/server/endpoints/list-models.js', () => ({ listAllModels: async () => [] }));
vi.mock('#lib/server/mcp/bootstrap.js', () => ({ awaitMcpReady: async () => {} }));
vi.mock('#lib/server/chat/tool-context.js', () => ({
	buildChatToolContext: async () => ({
		systemPrompt: null,
		toolDefs: [],
		needsApproval: () => false,
		unavailableMcpServers: [],
	}),
	augmentRequestForCanvas: (body: unknown) => body,
}));
vi.mock('#lib/server/chat/persona-context.js', () => ({ composePersonaPrompt: () => null }));
vi.mock('#lib/server/streaming/relay.js', () => ({
	startStreamingRelay: async () => new ReadableStream(),
}));

import { POST } from '../../src/routes/api/conversations/[id]/tool-approval/+server';
import { createConversation } from '#lib/server/db/queries/conversations.js';
import { appendMessage, walkActiveBranch } from '#lib/server/db/queries/messages.js';
import { register, _resetForTests } from '#lib/server/tools/registry.js';
import { getInFlightEntries, resetInFlight } from '#lib/server/streaming/in-flight.js';
import { cancelInFlightGenerations } from '#lib/server/streaming/cancel.js';

beforeEach(() => {
	createTestDb();
});
afterEach(() => {
	resetInFlight();
	_resetForTests();
	closeTestDb();
});

/** A tool that takes a moment and honours its signal, as an MCP call or a
 *  fetch does. The returned promise resolves once it is running. */
function registerSlowTool(): Promise<void> {
	let started!: () => void;
	const running = new Promise<void>((r) => (started = r));
	register({
		definition: {
			type: 'function',
			function: {
				name: 'mcp__srv__send',
				description: 'send',
				parameters: { type: 'object', properties: {} },
			},
		},
		execute: (_args, ctx) =>
			new Promise((resolve, reject) => {
				started();
				const t = setTimeout(() => resolve({ content: '{"sent":true}' }), 150);
				ctx.signal.addEventListener('abort', () => {
					clearTimeout(t);
					reject(new DOMException('This operation was aborted', 'AbortError'));
				});
			}),
	});
	return running;
}

/** A conversation paused on one pending call, and an approval POST for it
 *  whose request signal aborts when `client` does — what adapter-node hands
 *  the handler. */
function approve(client: AbortController) {
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
		parent = appendMessage({ conversationId: conv.id, parentMessageId: parent, role, parts }).id;
	};
	add('user', [{ type: 'text', text: 'send it' }]);
	add('assistant', [
		{ type: 'tool_call', toolCallId: 'call_1', toolName: 'mcp__srv__send', arguments: '{}' },
	]);
	add('tool', [
		{ type: 'tool_result', toolCallId: 'call_1', result: '', status: 'pending_approval' },
	]);

	const url = new URL(`http://x/api/conversations/${conv.id}/tool-approval`);
	const request = new Request(url, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ decisions: [{ toolCallId: 'call_1', action: 'allow' }] }),
		signal: client.signal,
	});
	const response = POST({
		locals: { user: { id: u.id } },
		params: { id: conv.id },
		request,
		url,
	} as unknown as Parameters<typeof POST>[0]);
	const toolResult = () => {
		const row = walkActiveBranch(conv.id, { columns: 'serialization' }).find(
			(m) => m.role === 'tool',
		)!;
		return row.parts.find((p) => p.type === 'tool_result')!;
	};
	return { conversationId: conv.id, response, toolResult };
}

it('an approved tool is not aborted when the approving request disconnects', async () => {
	const running = registerSlowTool();
	const client = new AbortController();
	const { response, toolResult } = approve(client);

	await running;
	client.abort();
	await response;

	const result = toolResult();
	expect(result).toMatchObject({ type: 'tool_result', result: '{"sent":true}' });
	expect('isError' in result && result.isError).toBeFalsy();
});

it('Stop during an approved tool does abort it', async () => {
	const running = registerSlowTool();
	const { conversationId, response, toolResult } = approve(new AbortController());

	await running;
	expect(getInFlightEntries(conversationId)).toHaveLength(1);
	await cancelInFlightGenerations(conversationId);
	await response;

	expect(toolResult()).toMatchObject({ type: 'tool_result', isError: true });
});
