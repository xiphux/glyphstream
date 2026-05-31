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
	closeDb: () => {},
}));

import { executeToolCalls } from '$lib/server/streaming/tool-execution';
import {
	appendMessage,
	getMessage,
	updateMessageParts,
	walkActiveBranch,
} from '$lib/server/db/queries/messages';
import { createConversation } from '$lib/server/db/queries/conversations';

const REGISTERED_TOOLS = new Set<string>();

function registerMockTool(name: string, execute: Tool['execute'], category?: string): void {
	if (REGISTERED_TOOLS.has(name)) return;
	register({
		definition: {
			type: 'function',
			function: { name, description: '', parameters: { type: 'object' } },
		},
		metadata: category ? { category } : undefined,
		execute,
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
			'mcp:fs',
		);
		const conv = createConversation({
			userId: u.id,
			endpointId: 'bridge',
			modelId: 'bridge::gpt-4o',
			modelKind: 'chat',
			customModelId: null,
			systemPrompt: null,
		});
		const user = appendMessage({
			conversationId: conv.id,
			parentMessageId: null,
			role: 'user',
			parts: [{ type: 'text', text: 'read /etc/hosts please' }],
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
					arguments: '{"path":"/etc/hosts"}',
				},
			],
		});

		const events: StreamEvent[] = [];
		const result = await executeToolCalls({
			assistantMessage: assistant,
			conversationId: conv.id,
			userId: u.id,
			emit: (e) => events.push(e),
			needsApproval: () => true,
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
		registerMockTool('auto_tool', async (): Promise<ToolExecution> => ({ content: 'computed-ok' }));
		const conv = createConversation({
			userId: u.id,
			endpointId: 'bridge',
			modelId: 'bridge::gpt-4o',
			modelKind: 'chat',
			customModelId: null,
			systemPrompt: null,
		});
		const user = appendMessage({
			conversationId: conv.id,
			parentMessageId: null,
			role: 'user',
			parts: [{ type: 'text', text: 'go' }],
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
					arguments: '{}',
				},
			],
		});

		const result = await executeToolCalls({
			assistantMessage: assistant,
			conversationId: conv.id,
			userId: u.id,
			emit: () => {},
			needsApproval: () => false,
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
	it('returns the toolCallIds of pending_approval rows in branch order', () => {
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
				createdAt: 1,
			},
			{
				id: 'a1',
				role: 'assistant',
				parts: [
					{
						type: 'tool_call',
						toolCallId: 'call_x',
						toolName: 'mcp__fs__read_file',
						arguments: '{"path":"/tmp"}',
					},
					{
						type: 'tool_call',
						toolCallId: 'call_y',
						toolName: 'mcp__fs__list_directory',
						arguments: '{"path":"/var"}',
					},
				],
				contentHtml: null,
				reasoningText: null,
				finishReason: 'tool_calls',
				modelUsed: null,
				tokensIn: null,
				tokensOut: null,
				createdAt: 2,
			},
			{
				id: 't1',
				role: 'tool',
				parts: [
					{
						type: 'tool_result',
						toolCallId: 'call_x',
						result: '',
						status: 'pending_approval',
					},
				],
				contentHtml: null,
				reasoningText: null,
				finishReason: null,
				modelUsed: null,
				tokensIn: null,
				tokensOut: null,
				createdAt: 3,
			},
			{
				id: 't2',
				role: 'tool',
				parts: [
					{
						type: 'tool_result',
						toolCallId: 'call_y',
						result: '',
						status: 'pending_approval',
					},
				],
				contentHtml: null,
				reasoningText: null,
				finishReason: null,
				modelUsed: null,
				tokensIn: null,
				tokensOut: null,
				createdAt: 4,
			},
		];
		expect(buildPendingApprovals(branch)).toEqual(['call_x', 'call_y']);
	});

	it('skips already-completed tool_result rows', () => {
		const branch: ChatMessage[] = [
			{
				id: 't1',
				role: 'tool',
				parts: [
					{
						type: 'tool_result',
						toolCallId: 'call_x',
						result: '',
						status: 'pending_approval',
					},
				],
				contentHtml: null,
				reasoningText: null,
				finishReason: null,
				modelUsed: null,
				tokensIn: null,
				tokensOut: null,
				createdAt: 1,
			},
			{
				id: 't2',
				role: 'tool',
				parts: [
					{
						type: 'tool_result',
						toolCallId: 'call_y',
						result: 'done',
						status: 'completed',
					},
				],
				contentHtml: null,
				reasoningText: null,
				finishReason: null,
				modelUsed: null,
				tokensIn: null,
				tokensOut: null,
				createdAt: 2,
			},
		];
		expect(buildPendingApprovals(branch)).toEqual(['call_x']);
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
						result: 'done',
					},
				],
				contentHtml: null,
				reasoningText: null,
				finishReason: null,
				modelUsed: null,
				tokensIn: null,
				tokensOut: null,
				createdAt: 1,
			},
		];
		expect(buildPendingApprovals(branch)).toEqual([]);
	});
});

describe('updateMessageParts', () => {
	// Used by the approval-resume endpoint to fill in a previously-
	// pending tool_result row with the actual execution output (or the
	// declined-error result on reject). The DB shape matters because
	// the relay continues from this state — a missing update would
	// leave the row visible as pending forever.

	it('rewrites the parts JSON of an existing message', () => {
		const u = seedUser();
		const conv = createConversation({
			userId: u.id,
			endpointId: 'bridge',
			modelId: 'bridge::gpt-4o',
			modelKind: 'chat',
			customModelId: null,
			systemPrompt: null,
		});
		const user = appendMessage({
			conversationId: conv.id,
			parentMessageId: null,
			role: 'user',
			parts: [{ type: 'text', text: 'go' }],
		});
		const assistant = appendMessage({
			conversationId: conv.id,
			parentMessageId: user.id,
			role: 'assistant',
			parts: [
				{
					type: 'tool_call',
					toolCallId: 'call_x',
					toolName: 'mcp__fs__read_file',
					arguments: '{}',
				},
			],
		});
		const pendingResult = appendMessage({
			conversationId: conv.id,
			parentMessageId: assistant.id,
			role: 'tool',
			parts: [
				{
					type: 'tool_result',
					toolCallId: 'call_x',
					result: '',
					status: 'pending_approval',
				},
			],
		});

		const ok = updateMessageParts(pendingResult.id, conv.id, [
			{
				type: 'tool_result',
				toolCallId: 'call_x',
				result: 'file contents here',
			},
		]);
		expect(ok).toBe(true);
		const persisted = getMessage(conv.id, pendingResult.id)!;
		expect(persisted.parts).toEqual([
			{ type: 'tool_result', toolCallId: 'call_x', result: 'file contents here' },
		]);
	});

	it('returns false on a no-op update against the wrong message id', () => {
		const u = seedUser();
		const conv = createConversation({
			userId: u.id,
			endpointId: 'bridge',
			modelId: 'bridge::gpt-4o',
			modelKind: 'chat',
			customModelId: null,
			systemPrompt: null,
		});
		const user = appendMessage({
			conversationId: conv.id,
			parentMessageId: null,
			role: 'user',
			parts: [{ type: 'text', text: 'go' }],
		});
		// `user.id` is a real row but with a *different* conversationId
		// scope on the predicate — cross-conversation update must fail.
		expect(updateMessageParts(user.id, 'no-such-convo-id', [])).toBe(false);
	});

	it('does not move active_leaf_message_id (it edits in place)', () => {
		// The relay parents the next iteration's assistant message at
		// the current active_leaf. The resume endpoint only EDITS the
		// pending tool_result row to fill in its result — it does not
		// append new rows. Active_leaf must stay anchored to that tool
		// message so initialParentMessageId can re-use it on the
		// continued iteration (the previous "branching on every
		// approval cycle" bug came from this anchor drifting).
		const u = seedUser();
		const conv = createConversation({
			userId: u.id,
			endpointId: 'bridge',
			modelId: 'bridge::gpt-4o',
			modelKind: 'chat',
			customModelId: null,
			systemPrompt: null,
		});
		const user = appendMessage({
			conversationId: conv.id,
			parentMessageId: null,
			role: 'user',
			parts: [{ type: 'text', text: 'go' }],
		});
		const assistant = appendMessage({
			conversationId: conv.id,
			parentMessageId: user.id,
			role: 'assistant',
			parts: [
				{
					type: 'tool_call',
					toolCallId: 'call_x',
					toolName: 'mcp__fs__read_file',
					arguments: '{}',
				},
			],
		});
		const pending = appendMessage({
			conversationId: conv.id,
			parentMessageId: assistant.id,
			role: 'tool',
			parts: [
				{
					type: 'tool_result',
					toolCallId: 'call_x',
					result: '',
					status: 'pending_approval',
				},
			],
		});
		const branchBefore = walkActiveBranch(conv.id).map((m) => m.id);
		updateMessageParts(pending.id, conv.id, [
			{ type: 'tool_result', toolCallId: 'call_x', result: 'ok' },
		]);
		const branchAfter = walkActiveBranch(conv.id).map((m) => m.id);
		expect(branchAfter).toEqual(branchBefore);
		expect(branchAfter[branchAfter.length - 1]).toBe(pending.id);
	});
});
