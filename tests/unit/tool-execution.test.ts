import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb, closeTestDb } from './_helpers/test-db';
import { seedUser } from './_helpers/seed';

import { createConversation } from '#lib/server/db/queries/conversations.js';
import { appendMessage, getMessage, walkActiveBranch } from '#lib/server/db/queries/messages.js';
import { serializeBranchForUpstream } from '#lib/server/endpoints/serialize-upstream.js';
import { _resetForTests, register } from '#lib/server/tools/registry.js';
import {
	executeToolCalls,
	executeOneToolCall,
	TOOL_RESULT_STORE_MAX_CHARS,
} from '#lib/server/streaming/tool-execution.js';
import type { ChatMessage, MessagePart, StreamEvent } from '#lib/types/api.js';
import type { Tool } from '#lib/server/tools/types.js';

beforeEach(() => {
	createTestDb();
	_resetForTests();
});

afterEach(() => {
	closeTestDb();
	_resetForTests();
});

function mkTool(name: string, exec: Tool['execute']): Tool {
	return {
		definition: {
			type: 'function',
			function: {
				name,
				description: name,
				parameters: { type: 'object', properties: {}, additionalProperties: false },
			},
		},
		execute: exec,
	};
}

function seedConversationWithAssistantToolCalls(
	toolCallParts: Array<Extract<MessagePart, { type: 'tool_call' }>>,
): { userId: string; conversationId: string; assistantMessage: ChatMessage } {
	const u = seedUser();
	const conv = createConversation({
		userId: u.id,
		endpointId: 'bridge',
		modelId: 'bridge::test',
		modelKind: 'chat',
	});
	const userMsg = appendMessage({
		conversationId: conv.id,
		parentMessageId: null,
		role: 'user',
		parts: [{ type: 'text', text: 'what time is it?' }],
		contentHtml: null,
		reasoningText: null,
		finishReason: null,
		modelUsed: null,
		tokensIn: null,
		tokensOut: null,
	});
	const assistantMessage = appendMessage({
		conversationId: conv.id,
		parentMessageId: userMsg.id,
		role: 'assistant',
		parts: [{ type: 'text', text: 'checking…' }, ...toolCallParts],
		contentHtml: null,
		reasoningText: null,
		finishReason: 'tool_calls',
		modelUsed: 'bridge::test',
		tokensIn: 10,
		tokensOut: 5,
	});
	return { userId: u.id, conversationId: conv.id, assistantMessage };
}

describe('executeToolCalls', () => {
	it('runs a registered tool and persists the result as a role:tool child', async () => {
		register(mkTool('echo', (args) => ({ content: JSON.stringify({ echoed: args }) })));
		const { conversationId, userId, assistantMessage } = seedConversationWithAssistantToolCalls([
			{ type: 'tool_call', toolCallId: 'call_1', toolName: 'echo', arguments: '{"x":1}' },
		]);
		const events: StreamEvent[] = [];

		const { toolMessages } = await executeToolCalls({
			assistantMessage,
			conversationId,
			userId,
			emit: (e) => events.push(e),
		});

		expect(toolMessages).toHaveLength(1);
		expect(toolMessages[0].role).toBe('tool');
		// appendMessage doesn't populate parentMessageId on the return value;
		// re-fetch to confirm the parent link landed in the DB.
		const persisted = getMessage(conversationId, toolMessages[0].id)!;
		expect(persisted.parentMessageId).toBe(assistantMessage.id);
		expect(toolMessages[0].parts).toEqual([
			{ type: 'tool_result', toolCallId: 'call_1', result: JSON.stringify({ echoed: { x: 1 } }) },
		]);

		// SSE event sequence per tool: executing → result
		expect(events).toEqual([
			{ type: 'tool_call_executing', toolCallId: 'call_1' },
			{
				type: 'tool_call_result',
				toolCallId: 'call_1',
				result: JSON.stringify({ echoed: { x: 1 } }),
				isError: false,
			},
		]);
	});

	it('advances active_leaf_message_id to the last tool message', async () => {
		register(mkTool('echo', () => ({ content: 'ok' })));
		const { conversationId, assistantMessage, userId } = seedConversationWithAssistantToolCalls([
			{ type: 'tool_call', toolCallId: 'a', toolName: 'echo', arguments: '{}' },
			{ type: 'tool_call', toolCallId: 'b', toolName: 'echo', arguments: '{}' },
		]);
		const { toolMessages } = await executeToolCalls({
			assistantMessage,
			conversationId,
			userId,
			emit: () => {},
		});

		// Active leaf moves to the LAST persisted tool message — its id
		// becomes the parent for any follow-up upstream call (PR5).
		const branch = walkActiveBranch(conversationId);
		expect(branch[branch.length - 1].id).toBe(toolMessages[1].id);

		// Both tool rows are on the active branch (chained, not off-chain
		// siblings), so walkActiveBranch's leaf→root walk finds both.
		const branchIds = branch.map((m) => m.id);
		expect(branchIds).toContain(toolMessages[0].id);
		expect(branchIds).toContain(toolMessages[1].id);

		// The tool messages appear in order (first tool before second tool).
		const branchRoles = branch.map((m) => m.role);
		const firstToolIdx = branchRoles.indexOf('tool');
		expect(firstToolIdx).toBeGreaterThanOrEqual(0);
		expect(branch[firstToolIdx].id).toBe(toolMessages[0].id);
		expect(branch[firstToolIdx + 1].id).toBe(toolMessages[1].id);

		// Serialize the branch for upstream and confirm every tool_call_id
		// has a matching role:'tool' response.
		const serialized = await serializeBranchForUpstream(
			branch,
			async () => 'data:image/png;base64,',
			null,
		);
		const toolResults = serialized.filter((m) => m.role === 'tool');
		expect(toolResults).toHaveLength(2);
		expect(toolResults[0]).toEqual({
			role: 'tool',
			content: 'ok',
			tool_call_id: 'a',
		});
		expect(toolResults[1]).toEqual({
			role: 'tool',
			content: 'ok',
			tool_call_id: 'b',
		});
	});

	it('persists tool_calls in upstream index order even though execute is parallel', async () => {
		// Use deliberate latency mismatch to confirm we don't accidentally
		// linearize by completion time.
		register(
			mkTool('slow', async () => {
				await new Promise((r) => setTimeout(r, 20));
				return { content: 'slow-result' };
			}),
		);
		register(mkTool('fast', () => ({ content: 'fast-result' })));
		const { conversationId, assistantMessage, userId } = seedConversationWithAssistantToolCalls([
			{ type: 'tool_call', toolCallId: 'slow-1', toolName: 'slow', arguments: '{}' },
			{ type: 'tool_call', toolCallId: 'fast-1', toolName: 'fast', arguments: '{}' },
		]);
		const { toolMessages } = await executeToolCalls({
			assistantMessage,
			conversationId,
			userId,
			emit: () => {},
		});
		expect(toolMessages).toHaveLength(2);
		const [first, second] = toolMessages;
		expect((first.parts[0] as { toolCallId: string }).toolCallId).toBe('slow-1');
		expect((second.parts[0] as { toolCallId: string }).toolCallId).toBe('fast-1');
	});

	it('caps an oversized result before storing and streaming it, keeping head and tail', async () => {
		const huge = `HEAD${'x'.repeat(2_000_000)}TAIL`;
		register(mkTool('dumps', () => ({ content: huge })));
		const { conversationId, assistantMessage, userId } = seedConversationWithAssistantToolCalls([
			{ type: 'tool_call', toolCallId: 'c1', toolName: 'dumps', arguments: '{}' },
		]);
		const events: StreamEvent[] = [];
		const { toolMessages } = await executeToolCalls({
			assistantMessage,
			conversationId,
			userId,
			emit: (e) => events.push(e),
		});
		const part = toolMessages[0].parts[0] as Extract<MessagePart, { type: 'tool_result' }>;
		expect(part.result.length).toBeLessThanOrEqual(TOOL_RESULT_STORE_MAX_CHARS);
		expect(part.result.startsWith('HEAD')).toBe(true);
		expect(part.result.endsWith('TAIL')).toBe(true);
		const streamed = events.find((e) => e.type === 'tool_call_result') as { result: string };
		expect(streamed.result).toBe(part.result);
	});

	it('returns isError when the tool is unknown', async () => {
		const { conversationId, assistantMessage, userId } = seedConversationWithAssistantToolCalls([
			{ type: 'tool_call', toolCallId: 'c1', toolName: 'no_such_tool', arguments: '{}' },
		]);
		const events: StreamEvent[] = [];
		const { toolMessages } = await executeToolCalls({
			assistantMessage,
			conversationId,
			userId,
			emit: (e) => events.push(e),
		});
		expect(toolMessages).toHaveLength(1);
		const part = toolMessages[0].parts[0] as Extract<MessagePart, { type: 'tool_result' }>;
		expect(part.isError).toBe(true);
		expect((JSON.parse(part.result) as { error: string }).error).toMatch(/Unknown tool/);
		// The error result SSE event also carries isError: true
		const last = events[events.length - 1];
		expect(last).toMatchObject({ type: 'tool_call_result', isError: true });
	});

	it('returns isError when the arguments JSON is malformed', async () => {
		register(mkTool('echo', () => ({ content: 'never called' })));
		const { conversationId, assistantMessage, userId } = seedConversationWithAssistantToolCalls([
			{
				type: 'tool_call',
				toolCallId: 'c1',
				toolName: 'echo',
				arguments: 'not-valid-json{',
			},
		]);
		const { toolMessages } = await executeToolCalls({
			assistantMessage,
			conversationId,
			userId,
			emit: () => {},
		});
		const part = toolMessages[0].parts[0] as Extract<MessagePart, { type: 'tool_result' }>;
		expect(part.isError).toBe(true);
		expect((JSON.parse(part.result) as { error: string }).error).toMatch(/did not parse as JSON/);
	});

	it('returns isError when the tool throws', async () => {
		register(
			mkTool('boom', () => {
				throw new Error('intentional');
			}),
		);
		const { conversationId, assistantMessage, userId } = seedConversationWithAssistantToolCalls([
			{ type: 'tool_call', toolCallId: 'c1', toolName: 'boom', arguments: '{}' },
		]);
		const { toolMessages } = await executeToolCalls({
			assistantMessage,
			conversationId,
			userId,
			emit: () => {},
		});
		const part = toolMessages[0].parts[0] as Extract<MessagePart, { type: 'tool_result' }>;
		expect(part.isError).toBe(true);
		expect((JSON.parse(part.result) as { error: string }).error).toMatch(/intentional/);
	});

	it('respects the isError flag from a tool that returns it directly', async () => {
		register(mkTool('graceful_fail', () => ({ content: 'sorry', isError: true })));
		const { conversationId, assistantMessage, userId } = seedConversationWithAssistantToolCalls([
			{ type: 'tool_call', toolCallId: 'c1', toolName: 'graceful_fail', arguments: '{}' },
		]);
		const events: StreamEvent[] = [];
		const { toolMessages } = await executeToolCalls({
			assistantMessage,
			conversationId,
			userId,
			emit: (e) => events.push(e),
		});
		const part = toolMessages[0].parts[0] as Extract<MessagePart, { type: 'tool_result' }>;
		expect(part.isError).toBe(true);
		expect(part.result).toBe('sorry');
		expect(events[events.length - 1]).toMatchObject({
			type: 'tool_call_result',
			isError: true,
		});
	});

	it('aggregates activatedToolNames from completed tools and persists them on the part', async () => {
		register(
			mkTool('search_tools', () => ({
				content: 'found',
				activatedToolNames: ['mcp__gh__create_issue', 'mcp__gh__view_issue'],
			})),
		);
		const { conversationId, assistantMessage, userId } = seedConversationWithAssistantToolCalls([
			{ type: 'tool_call', toolCallId: 'c1', toolName: 'search_tools', arguments: '{"query":"x"}' },
		]);
		const { toolMessages, activatedToolNames } = await executeToolCalls({
			assistantMessage,
			conversationId,
			userId,
			emit: () => {},
		});
		expect(activatedToolNames).toEqual(['mcp__gh__create_issue', 'mcp__gh__view_issue']);
		// Persisted on the tool_result part so the next turn's branch scan finds it.
		const persisted = getMessage(conversationId, toolMessages[0].id)!;
		const part = persisted.parts[0] as Extract<MessagePart, { type: 'tool_result' }>;
		expect(part.activatedToolNames).toEqual(['mcp__gh__create_issue', 'mcp__gh__view_issue']);
	});

	it('omits activatedToolNames on the part for tools that do not surface tools', async () => {
		register(mkTool('echo', () => ({ content: 'ok' })));
		const { conversationId, assistantMessage, userId } = seedConversationWithAssistantToolCalls([
			{ type: 'tool_call', toolCallId: 'c1', toolName: 'echo', arguments: '{}' },
		]);
		const { toolMessages, activatedToolNames } = await executeToolCalls({
			assistantMessage,
			conversationId,
			userId,
			emit: () => {},
		});
		expect(activatedToolNames).toEqual([]);
		const part = toolMessages[0].parts[0] as Extract<MessagePart, { type: 'tool_result' }>;
		expect('activatedToolNames' in part).toBe(false);
	});

	it('returns an empty array when the assistant has no tool_call parts', async () => {
		const { conversationId, assistantMessage, userId } = seedConversationWithAssistantToolCalls([]);
		const events: StreamEvent[] = [];
		const { toolMessages } = await executeToolCalls({
			assistantMessage,
			conversationId,
			userId,
			emit: (e) => events.push(e),
		});
		expect(toolMessages).toEqual([]);
		expect(events).toEqual([]);
	});

	it('chains mixed pending_approval and auto-executed tool rows on the active branch', async () => {
		register(mkTool('auto_tool', () => ({ content: 'auto-result' })));
		register(
			mkTool('approval_tool', () => {
				throw new Error('must not execute when pending');
			}),
		);
		const { conversationId, assistantMessage, userId } = seedConversationWithAssistantToolCalls([
			{ type: 'tool_call', toolCallId: 'call_auto', toolName: 'auto_tool', arguments: '{}' },
			{
				type: 'tool_call',
				toolCallId: 'call_approval',
				toolName: 'approval_tool',
				arguments: '{}',
			},
		]);
		const { toolMessages, pendingCount } = await executeToolCalls({
			assistantMessage,
			conversationId,
			userId,
			emit: () => {},
			needsApproval: (name) => name === 'approval_tool',
		});

		expect(toolMessages).toHaveLength(2);
		expect(pendingCount).toBe(1);

		// Both tool rows are on the active branch (chained, not off-chain siblings).
		const branch = walkActiveBranch(conversationId);
		const branchIds = branch.map((m) => m.id);
		expect(branchIds).toContain(toolMessages[0].id);
		expect(branchIds).toContain(toolMessages[1].id);

		// Auto-executed tool has its content
		const autoPart = toolMessages[0].parts[0] as Extract<MessagePart, { type: 'tool_result' }>;
		expect(autoPart.toolCallId).toBe('call_auto');
		expect(autoPart.result).toBe('auto-result');

		// Pending tool has the placeholder shape
		const pendingPart = toolMessages[1].parts[0] as Extract<MessagePart, { type: 'tool_result' }>;
		expect(pendingPart.toolCallId).toBe('call_approval');
		expect(pendingPart.result).toBe('');
		expect(pendingPart.status).toBe('pending_approval');

		// Serialization preserves both tool results
		const serialized = await serializeBranchForUpstream(
			branch,
			async () => 'data:image/png;base64,',
			null,
		);
		const toolResults = serialized.filter((m) => m.role === 'tool');
		expect(toolResults).toHaveLength(2);
		expect(toolResults[0]).toMatchObject({ role: 'tool', tool_call_id: 'call_auto' });
		expect(toolResults[1]).toMatchObject({ role: 'tool', tool_call_id: 'call_approval' });
	});

	it('applies a timeout via executeOneToolCall (approval path coverage), distinguishing timeout from throw', async () => {
		// Use a cooperative tool that waits for the abort signal.
		// The tool's short timeoutMs simulates a hung MCP peer.
		const tool = mkTool('slow', async (_args, ctx) => {
			await new Promise((_, reject) => {
				if (ctx.signal.aborted) {
					reject(new DOMException('Aborted', 'AbortError'));
					return;
				}
				ctx.signal.addEventListener('abort', () => {
					reject(new DOMException('Aborted', 'AbortError'));
				});
			});
			return { content: 'never' };
		});
		tool.timeoutMs = 200;
		register(tool);

		const part: Extract<MessagePart, { type: 'tool_call' }> = {
			type: 'tool_call',
			toolCallId: 'call_slow',
			toolName: 'slow',
			arguments: '{}',
		};
		const signal = new AbortController().signal;
		const { execution } = await executeOneToolCall(part, 'u1', 'c1', signal, []);

		expect(execution.isError).toBe(true);
		// The error message should say "exceeded its Nms timeout", distinguishing
		// timeout from a generic throw — this is the fix that was missing from
		// the approval-resume path (B6).
		expect(execution.content).toContain('exceeded its 200ms timeout');
	}, 10_000);
});

describe('tools in a disabled category', () => {
	function categorized(name: string, category: string, ran: { count: number }): Tool {
		return {
			...mkTool(name, () => {
				ran.count++;
				return { content: 'ran' };
			}),
			metadata: { category },
		};
	}

	it('refuses a call by name to a tool the conversation switched off', async () => {
		// The model saw web_search in the history from before the user turned web
		// access off, and calls it again. Not advertised is not enough.
		const ran = { count: 0 };
		register(categorized('web_search', 'web', ran));
		const { userId, conversationId, assistantMessage } = seedConversationWithAssistantToolCalls([
			{ type: 'tool_call', toolCallId: 'c1', toolName: 'web_search', arguments: '{}' },
		]);

		const { toolMessages } = await executeToolCalls({
			assistantMessage,
			conversationId,
			userId,
			disabledFeatures: ['web'],
			emit: () => {},
		});

		expect(ran.count).toBe(0);
		expect(toolMessages[0].parts[0]).toMatchObject({
			type: 'tool_result',
			isError: true,
			result: expect.stringContaining('turned off for this conversation') as unknown,
		});
	});

	it("doesn't ask approval for a tool it would refuse", async () => {
		const ran = { count: 0 };
		register(categorized('mcp__mail__send', 'mcp:mail', ran));
		const { userId, conversationId, assistantMessage } = seedConversationWithAssistantToolCalls([
			{ type: 'tool_call', toolCallId: 'c1', toolName: 'mcp__mail__send', arguments: '{}' },
		]);
		const events: StreamEvent[] = [];

		const { pendingCount } = await executeToolCalls({
			assistantMessage,
			conversationId,
			userId,
			disabledFeatures: ['mcp:mail'],
			emit: (e) => events.push(e),
			needsApproval: () => true,
		});

		expect(pendingCount).toBe(0);
		expect(events.some((e) => e.type === 'tool_pending_approval')).toBe(false);
		expect(ran.count).toBe(0);
	});

	it('refuses on the approval-resume path too', async () => {
		const ran = { count: 0 };
		register(categorized('mcp__mail__send', 'mcp:mail', ran));
		const { userId, conversationId } = seedConversationWithAssistantToolCalls([]);

		const r = await executeOneToolCall(
			{ type: 'tool_call', toolCallId: 'c1', toolName: 'mcp__mail__send', arguments: '{}' },
			userId,
			conversationId,
			new AbortController().signal,
			['mcp:mail'],
		);

		expect(r.execution.isError).toBe(true);
		expect(ran.count).toBe(0);
	});

	it('still runs tools whose category is enabled', async () => {
		const ran = { count: 0 };
		register(categorized('web_search', 'web', ran));
		const { userId, conversationId } = seedConversationWithAssistantToolCalls([]);

		const r = await executeOneToolCall(
			{ type: 'tool_call', toolCallId: 'c1', toolName: 'web_search', arguments: '{}' },
			userId,
			conversationId,
			new AbortController().signal,
			['canvas'],
		);

		expect(r.execution).toEqual({ content: 'ran' });
		expect(ran.count).toBe(1);
	});
});

describe("a scheduled run's tool allowlist", () => {
	it('refuses a tool the policy leaves out, without asking', async () => {
		let ran = 0;
		register(
			mkTool('mcp__mail__delete', () => {
				ran++;
				return { content: 'deleted' };
			}),
		);
		const { userId, conversationId, assistantMessage } = seedConversationWithAssistantToolCalls([
			{ type: 'tool_call', toolCallId: 'c1', toolName: 'mcp__mail__delete', arguments: '{}' },
		]);
		const events: StreamEvent[] = [];

		const { toolMessages, pendingCount } = await executeToolCalls({
			assistantMessage,
			conversationId,
			userId,
			emit: (e) => events.push(e),
			needsApproval: () => true,
			isToolPermitted: (n) => n !== 'mcp__mail__delete',
		});

		expect(ran).toBe(0);
		expect(pendingCount).toBe(0);
		expect(events.some((e) => e.type === 'tool_pending_approval')).toBe(false);
		expect(toolMessages[0].parts[0]).toMatchObject({
			isError: true,
			result: expect.stringContaining("isn't enabled for this scheduled task") as unknown,
		});
	});

	it('hands the allowlist to the tool, so a tool that finds tools can honor it', async () => {
		let seen: ((n: string) => boolean) | undefined;
		register(
			mkTool('search_tools', (_args, ctx) => {
				seen = ctx.isToolPermitted;
				return { content: 'ok' };
			}),
		);
		const { userId, conversationId } = seedConversationWithAssistantToolCalls([]);
		const permit = (n: string) => n === 'search_tools';

		await executeOneToolCall(
			{ type: 'tool_call', toolCallId: 'c1', toolName: 'search_tools', arguments: '{}' },
			userId,
			conversationId,
			new AbortController().signal,
			[],
			permit,
		);

		expect(seen).toBe(permit);
	});
});
