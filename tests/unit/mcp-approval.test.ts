/**
 * Unit tests for the MCP approval partition step inside executeToolCalls
 * + the chat-render helper that surfaces pending rows to the UI.
 *
 * The relay loop test in tests/unit/relay-loop.test.ts already exercises
 * the "halt on pendingCount > 0" branch; here we test the lower-level
 * primitives that feed it.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDb, closeTestDb, type TestDB } from './_helpers/test-db';
import { seedUser } from './_helpers/seed';
import { register } from '$lib/server/tools/registry';
import type { Tool, ToolExecution } from '$lib/server/tools/types';
import { buildPendingApprovals } from '$lib/chat-render';
import type { ChatMessage, MessagePart, StreamEvent } from '$lib/types/api';

const mocks = vi.hoisted(() => ({ testDb: null as unknown as TestDB }));
vi.mock('$lib/server/db/client', () => ({
	getDb: () => mocks.testDb,
	closeDb: () => {}
}));

import { executeToolCalls } from '$lib/server/streaming/tool-execution';
import { appendMessage } from '$lib/server/db/queries/messages';
import { createConversation } from '$lib/server/db/queries/conversations';

const REGISTERED_TOOLS = new Set<string>();

function registerMockTool(name: string, execute: Tool['execute'], category?: string): void {
	if (REGISTERED_TOOLS.has(name)) return;
	register({
		definition: {
			type: 'function',
			function: { name, description: '', parameters: { type: 'object' } }
		},
		metadata: category ? { category } : undefined,
		execute
	});
	REGISTERED_TOOLS.add(name);
}

beforeEach(() => {
	mocks.testDb = createTestDb();
});

afterEach(() => {
	closeTestDb();
});

describe('executeToolCalls — approval partition', () => {
	it('persists a pending_approval row for tools the predicate flags', async () => {
		const u = seedUser();
		registerMockTool(
			'mcp__fs__read_file',
			async (): Promise<ToolExecution> => ({ content: 'ok' }),
			'mcp:fs'
		);
		const conv = createConversation({
			userId: u.id,
			endpointId: 'bridge',
			modelId: 'bridge::gpt-4o',
			modelKind: 'chat',
			customModelId: null,
			systemPrompt: null
		});
		const user = appendMessage({
			conversationId: conv.id,
			parentMessageId: null,
			role: 'user',
			parts: [{ type: 'text', text: 'read /etc/hosts please' }]
		});
		const assistant = appendMessage({
			conversationId: conv.id,
			parentMessageId: user.id,
			role: 'assistant',
			parts: [
				{
					type: 'tool_call',
					toolCallId: 'call_a',
					toolName: 'mcp__fs__read_file',
					arguments: '{"path":"/etc/hosts"}'
				}
			]
		});

		const events: StreamEvent[] = [];
		const result = await executeToolCalls({
			assistantMessage: assistant,
			conversationId: conv.id,
			userId: u.id,
			emit: (e) => events.push(e),
			needsApproval: () => true
		});

		expect(result.pendingCount).toBe(1);
		const persistedPart = result.toolMessages[0].parts[0] as Extract<
			MessagePart,
			{ type: 'tool_result' }
		>;
		expect(persistedPart.status).toBe('pending_approval');
		expect(persistedPart.result).toBe('');
		expect(events.some((e) => e.type === 'tool_pending_approval')).toBe(true);
	});

	it('executes inline tools whose predicate returns false', async () => {
		const u = seedUser();
		registerMockTool(
			'auto_tool',
			async (): Promise<ToolExecution> => ({ content: 'computed-ok' })
		);
		const conv = createConversation({
			userId: u.id,
			endpointId: 'bridge',
			modelId: 'bridge::gpt-4o',
			modelKind: 'chat',
			customModelId: null,
			systemPrompt: null
		});
		const user = appendMessage({
			conversationId: conv.id,
			parentMessageId: null,
			role: 'user',
			parts: [{ type: 'text', text: 'go' }]
		});
		const assistant = appendMessage({
			conversationId: conv.id,
			parentMessageId: user.id,
			role: 'assistant',
			parts: [
				{
					type: 'tool_call',
					toolCallId: 'call_b',
					toolName: 'auto_tool',
					arguments: '{}'
				}
			]
		});

		const result = await executeToolCalls({
			assistantMessage: assistant,
			conversationId: conv.id,
			userId: u.id,
			emit: () => {},
			needsApproval: () => false
		});

		expect(result.pendingCount).toBe(0);
		const persistedPart = result.toolMessages[0].parts[0] as Extract<
			MessagePart,
			{ type: 'tool_result' }
		>;
		expect(persistedPart.status).toBeUndefined();
		expect(persistedPart.result).toBe('computed-ok');
	});
});

describe('buildPendingApprovals', () => {
	it('pairs pending tool_result rows with their parent assistant tool_call info', () => {
		const branch: ChatMessage[] = [
			{
				id: 'u1',
				role: 'user',
				parts: [{ type: 'text', text: 'hi' }],
				contentHtml: null,
				reasoningText: null,
				finishReason: null,
				modelUsed: null,
				tokensIn: null,
				tokensOut: null,
				createdAt: 1
			},
			{
				id: 'a1',
				role: 'assistant',
				parts: [
					{
						type: 'tool_call',
						toolCallId: 'call_x',
						toolName: 'mcp__fs__read_file',
						arguments: '{"path":"/tmp"}'
					}
				],
				contentHtml: null,
				reasoningText: null,
				finishReason: 'tool_calls',
				modelUsed: null,
				tokensIn: null,
				tokensOut: null,
				createdAt: 2
			},
			{
				id: 't1',
				role: 'tool',
				parts: [
					{
						type: 'tool_result',
						toolCallId: 'call_x',
						result: '',
						status: 'pending_approval'
					}
				],
				contentHtml: null,
				reasoningText: null,
				finishReason: null,
				modelUsed: null,
				tokensIn: null,
				tokensOut: null,
				createdAt: 3
			}
		];
		const pending = buildPendingApprovals(branch);
		expect(pending).toEqual([
			{
				toolCallId: 'call_x',
				toolName: 'mcp__fs__read_file',
				args: '{"path":"/tmp"}'
			}
		]);
	});

	it('returns [] when no rows are pending (status absent === completed)', () => {
		const branch: ChatMessage[] = [
			{
				id: 't1',
				role: 'tool',
				parts: [
					{
						type: 'tool_result',
						toolCallId: 'call_x',
						result: 'done'
					}
				],
				contentHtml: null,
				reasoningText: null,
				finishReason: null,
				modelUsed: null,
				tokensIn: null,
				tokensOut: null,
				createdAt: 1
			}
		];
		expect(buildPendingApprovals(branch)).toEqual([]);
	});
});
