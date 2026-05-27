/**
 * Tool execution stage: runs each tool_call from a just-persisted
 * assistant message, persists a `role: 'tool'` child per result, and
 * emits real-time SSE events so the in-flight UI can fill in the
 * "executing → result" state without waiting for the whole turn.
 *
 * Independent of the streaming relay: relay.ts calls this between
 * "recorder persisted the assistant message" and "emit done." When PR5
 * adds the multi-iteration loop, that loop calls this same helper at
 * each iteration boundary.
 *
 * Tool execution is parallel via Promise.allSettled — every built-in
 * tool today (clock) is trivially side-effect-free. Future
 * side-effecting tools that need serial execution can carry an
 * opt-in flag on the Tool interface; we don't need it for v1.
 */

import type { ChatMessage, MessagePart, StreamEvent } from '$lib/types/api';
import { appendMessage, setActiveLeafMessageId } from '../db/queries/messages';
import { get as getTool } from '../tools/registry';
import type { ToolExecution } from '../tools/types';

export interface ExecuteToolCallsParams {
	/** The just-persisted assistant message that emitted the tool_calls.
	 *  Tool result messages will be parented to this row. */
	assistantMessage: ChatMessage;
	conversationId: string;
	userId: string;
	/** Forwarded to each tool's ToolContext so cooperative tools can
	 *  bail when the user clicks Stop. */
	signal?: AbortSignal;
	/** SSE writer for executing/result events. Disconnected clients
	 *  no-op (the underlying writer swallows). */
	emit: (event: StreamEvent) => void;
}

/**
 * Execute every tool_call on the given assistant message in parallel,
 * persist one role:'tool' child per result, and advance
 * active_leaf_message_id to the last tool message.
 *
 * Returns the persisted tool messages in the same order as the
 * tool_call parts on the assistant message (which is upstream's
 * `index` order). PR5 reads this to assemble the follow-up upstream
 * request.
 *
 * Persistence ordering matters: tool messages are inserted serially
 * after their parallel `execute()` calls settle, so created_at is
 * monotonic per row and the tree walk linearizes them deterministically.
 */
export async function executeToolCalls(params: ExecuteToolCallsParams): Promise<ChatMessage[]> {
	const toolCallParts = params.assistantMessage.parts.filter(
		(p): p is Extract<MessagePart, { type: 'tool_call' }> => p.type === 'tool_call'
	);
	if (toolCallParts.length === 0) return [];

	const signal = params.signal ?? new AbortController().signal;

	// Kick off all tools concurrently. Each task includes the emit calls
	// for executing/result so they fire in real time, not after the
	// Promise.allSettled barrier. Tools that fail throw or return
	// isError; either way they serialize into a `role: 'tool'` row so
	// the model can react to the failure (rather than the turn
	// blowing up).
	const executions = toolCallParts.map((part) => runOneTool(part, params, signal));
	const settled = await Promise.all(executions); // runOneTool catches internally — no rejections expected

	// Persist results serially so created_at strictly orders the rows.
	// Tree shape: each tool message's parent is the assistant message;
	// the active_leaf moves to whichever was persisted last (= last in
	// tool-call order). PR5 parents the next iteration's upstream call
	// to that same active_leaf.
	const toolMessages: ChatMessage[] = [];
	for (const { part, execution } of settled) {
		const toolMsg = appendMessage({
			conversationId: params.conversationId,
			parentMessageId: params.assistantMessage.id,
			role: 'tool',
			parts: [
				{
					type: 'tool_result',
					toolCallId: part.toolCallId,
					result: execution.content,
					...(execution.isError ? { isError: true } : {})
				}
			],
			contentHtml: null,
			reasoningText: null,
			finishReason: null,
			modelUsed: null,
			tokensIn: null,
			tokensOut: null
		});
		toolMessages.push(toolMsg);
	}

	if (toolMessages.length > 0) {
		setActiveLeafMessageId(params.conversationId, toolMessages[toolMessages.length - 1].id);
	}

	return toolMessages;
}

interface SettledToolExecution {
	part: Extract<MessagePart, { type: 'tool_call' }>;
	execution: ToolExecution;
}

async function runOneTool(
	part: Extract<MessagePart, { type: 'tool_call' }>,
	params: ExecuteToolCallsParams,
	signal: AbortSignal
): Promise<SettledToolExecution> {
	params.emit({ type: 'tool_call_executing', toolCallId: part.toolCallId });

	const tool = getTool(part.toolName);
	if (!tool) {
		const execution: ToolExecution = {
			content: JSON.stringify({ error: `Unknown tool: ${part.toolName}` }),
			isError: true
		};
		params.emit({
			type: 'tool_call_result',
			toolCallId: part.toolCallId,
			result: execution.content,
			isError: true
		});
		return { part, execution };
	}

	let args: unknown = {};
	if (part.arguments.length > 0) {
		try {
			args = JSON.parse(part.arguments);
		} catch (e) {
			const execution: ToolExecution = {
				content: JSON.stringify({
					error: `Tool arguments did not parse as JSON: ${e instanceof Error ? e.message : String(e)}`
				}),
				isError: true
			};
			params.emit({
				type: 'tool_call_result',
				toolCallId: part.toolCallId,
				result: execution.content,
				isError: true
			});
			return { part, execution };
		}
	}

	let execution: ToolExecution;
	try {
		execution = await Promise.resolve(
			tool.execute(args, {
				userId: params.userId,
				conversationId: params.conversationId,
				signal
			})
		);
	} catch (e) {
		execution = {
			content: JSON.stringify({
				error: `Tool "${part.toolName}" threw: ${e instanceof Error ? e.message : String(e)}`
			}),
			isError: true
		};
	}

	params.emit({
		type: 'tool_call_result',
		toolCallId: part.toolCallId,
		result: execution.content,
		isError: execution.isError === true
	});
	return { part, execution };
}
