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
import { appendMessage, setActiveLeafMessageId, updateMessageParts } from '../db/queries/messages';
import { getMediaForUser, linkMessageMedia } from '../db/queries/media';
import { get as getTool } from '../tools/registry';
import type { Tool, ToolExecution } from '../tools/types';

/**
 * Per-tool wall-clock cap when the tool itself doesn't declare one. A
 * tool whose execute() exceeds this gets its signal aborted and the
 * call resolves as an error result; the rest of the turn's tool_calls
 * settle on schedule rather than the whole turn hanging on one stuck
 * tool. 120s leaves room for slow web fetches / MCP round-trips while
 * still firing well before the upstream model's own request timeout.
 */
const DEFAULT_TOOL_TIMEOUT_MS = 120_000;

export interface ExecuteToolCallsParams {
	/** The just-persisted assistant message that emitted the tool_calls.
	 *  Tool result messages will be parented to this row. */
	assistantMessage: ChatMessage;
	conversationId: string;
	userId: string;
	/** Forwarded to each tool's ToolContext so cooperative tools can
	 *  bail when the user clicks Stop. */
	signal?: AbortSignal;
	/**
	 * Per-conversation feature-category opt-outs. Threaded through to
	 * each tool's `ToolContext` so behavior-only consumers (notably
	 * `run_python`'s network shim, gated by the `'web'` toggle) can
	 * honor the same conversation switches the model's tool-list filter
	 * uses. Defaults to `[]` when omitted.
	 */
	disabledFeatures?: readonly import('$lib/types/api').FeatureCategory[];
	/** SSE writer for executing/result events. Disconnected clients
	 *  no-op (the underlying writer swallows). */
	emit: (event: StreamEvent) => void;
	/**
	 * Predicate consulted before each tool's execute(). When it returns
	 * true, the tool is persisted as a pending_approval row instead of
	 * being run; the relay loop then halts so the user can Allow / Allow
	 * Always / Reject via the resume endpoint. Omitted → all tools
	 * execute inline (built-in tools today).
	 */
	needsApproval?: (toolName: string, tool: Tool | undefined) => boolean;
}

export interface ExecuteToolCallsResult {
	/** Persisted tool messages (mixed pending and completed). */
	toolMessages: ChatMessage[];
	/** Number of pending_approval rows persisted this iteration. When
	 *  non-zero, the relay must halt rather than rebuilding the next
	 *  upstream request body. */
	pendingCount: number;
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
export async function executeToolCalls(
	params: ExecuteToolCallsParams,
): Promise<ExecuteToolCallsResult> {
	const toolCallParts = params.assistantMessage.parts.filter(
		(p): p is Extract<MessagePart, { type: 'tool_call' }> => p.type === 'tool_call',
	);
	if (toolCallParts.length === 0) return { toolMessages: [], pendingCount: 0 };

	const signal = params.signal ?? new AbortController().signal;
	const needsApproval = params.needsApproval ?? (() => false);

	// Partition: tools the user hasn't approved (yet) get persisted as
	// pending_approval rows and emit an SSE event for the inline prompt;
	// every other tool runs inline as today.
	const settled = await Promise.all(
		toolCallParts.map(async (part) => {
			const tool = getTool(part.toolName);
			if (needsApproval(part.toolName, tool)) {
				params.emit({
					type: 'tool_pending_approval',
					toolCallId: part.toolCallId,
					toolName: part.toolName,
					displayLabel: tool?.metadata?.displayLabel,
					category: tool?.metadata?.category,
					args: part.arguments,
				});
				return { part, kind: 'pending' as const };
			}
			const execution = await runOneTool(part, params, signal);
			return { part, kind: 'completed' as const, execution: execution.execution };
		}),
	);

	// Persist results serially so created_at strictly orders the rows.
	// Tree shape: each tool message's parent is the assistant message;
	// the active_leaf moves to whichever was persisted last (= last in
	// tool-call order). The next iteration's upstream call parents to
	// that same active_leaf when the loop continues.
	const toolMessages: ChatMessage[] = [];
	let pendingCount = 0;
	for (const entry of settled) {
		const part = entry.part;
		// Pending rows carry `status: 'pending_approval'` + empty result;
		// completed rows omit the status field to stay byte-identical with
		// the pre-approval shape (read defenses default absent → completed).
		const partPayload: Extract<MessagePart, { type: 'tool_result' }> =
			entry.kind === 'pending'
				? {
						type: 'tool_result',
						toolCallId: part.toolCallId,
						result: '',
						status: 'pending_approval',
					}
				: {
						type: 'tool_result',
						toolCallId: part.toolCallId,
						result: entry.execution.content,
						...(entry.execution.isError ? { isError: true } : {}),
					};
		if (entry.kind === 'pending') pendingCount++;
		const toolMsg = appendMessage({
			conversationId: params.conversationId,
			parentMessageId: params.assistantMessage.id,
			role: 'tool',
			parts: [partPayload],
			contentHtml: null,
			reasoningText: null,
			finishReason: null,
			modelUsed: null,
			tokensIn: null,
			tokensOut: null,
		});
		// Tools may have created media during execute() (run_python
		// writes generated files via MediaStore; future tools may do
		// likewise). Link them to the freshly-persisted tool row so
		// the renderer can surface them as attachments and the orphan
		// reaper sees the same ref-count semantics user uploads use.
		// We also append matching MessageParts (image / video / file)
		// for each linked media so the existing render path draws
		// chips / inline previews on the tool bubble without needing
		// to consult the message_media join at render time.
		if (entry.kind === 'completed' && entry.execution.attachedMediaIds) {
			const extraParts: MessagePart[] = [];
			for (const mediaId of entry.execution.attachedMediaIds) {
				linkMessageMedia(toolMsg.id, mediaId);
				const m = getMediaForUser(mediaId, params.userId);
				if (!m) continue;
				if (m.kind === 'image') {
					extraParts.push({ type: 'image', mediaId });
				} else if (m.kind === 'video') {
					extraParts.push({ type: 'video', mediaId });
				} else {
					// 'file' kind — chip rendering with denormalized
					// filename + size so the renderer needs no lookup.
					extraParts.push({
						type: 'file',
						mediaId,
						filename: m.originalFilename ?? mediaId,
						byteSize: m.byteSize,
					});
				}
			}
			if (extraParts.length > 0) {
				updateMessageParts(toolMsg.id, params.conversationId, [partPayload, ...extraParts]);
				// Reflect the persisted change on the in-memory ChatMessage
				// the relay returns to its callers, so the very next
				// branch-walk after this turn sees the file parts too.
				toolMsg.parts = [partPayload, ...extraParts];
			}
		}
		toolMessages.push(toolMsg);
	}

	if (toolMessages.length > 0) {
		setActiveLeafMessageId(params.conversationId, toolMessages[toolMessages.length - 1].id);
	}

	return { toolMessages, pendingCount };
}

interface SettledToolExecution {
	part: Extract<MessagePart, { type: 'tool_call' }>;
	execution: ToolExecution;
}

async function runOneTool(
	part: Extract<MessagePart, { type: 'tool_call' }>,
	params: ExecuteToolCallsParams,
	signal: AbortSignal,
): Promise<SettledToolExecution> {
	params.emit({ type: 'tool_call_executing', toolCallId: part.toolCallId });

	const tool = getTool(part.toolName);
	if (!tool) {
		const execution: ToolExecution = {
			content: JSON.stringify({ error: `Unknown tool: ${part.toolName}` }),
			isError: true,
		};
		params.emit({
			type: 'tool_call_result',
			toolCallId: part.toolCallId,
			result: execution.content,
			isError: true,
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
					error: `Tool arguments did not parse as JSON: ${e instanceof Error ? e.message : String(e)}`,
				}),
				isError: true,
			};
			params.emit({
				type: 'tool_call_result',
				toolCallId: part.toolCallId,
				result: execution.content,
				isError: true,
			});
			return { part, execution };
		}
	}

	const timeoutMs = tool.timeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS;
	const timeoutSignal = AbortSignal.timeout(timeoutMs);
	const combinedSignal = AbortSignal.any([signal, timeoutSignal]);

	let execution: ToolExecution;
	try {
		execution = await Promise.resolve(
			tool.execute(args, {
				userId: params.userId,
				conversationId: params.conversationId,
				signal: combinedSignal,
				disabledFeatures: params.disabledFeatures ?? [],
			}),
		);
	} catch (e) {
		// Distinguish timeout from arbitrary throws so the model gets a
		// clear "this tool ran out of time" rather than a generic abort
		// error — helps it decide whether to retry with shorter input.
		if (timeoutSignal.aborted && !signal.aborted) {
			execution = {
				content: JSON.stringify({
					error: `Tool "${part.toolName}" exceeded its ${timeoutMs}ms timeout`,
				}),
				isError: true,
			};
		} else {
			execution = {
				content: JSON.stringify({
					error: `Tool "${part.toolName}" threw: ${e instanceof Error ? e.message : String(e)}`,
				}),
				isError: true,
			};
		}
	}

	params.emit({
		type: 'tool_call_result',
		toolCallId: part.toolCallId,
		result: execution.content,
		isError: execution.isError === true,
	});
	return { part, execution };
}
