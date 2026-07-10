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
	/** Union of tool names any completed tool made callable this iteration
	 *  (today: `search_tools` matches). The relay accumulates these across the
	 *  turn and re-includes their full definitions in the next iteration's
	 *  `tools[]` so the model can call them. Empty for the common case. */
	activatedToolNames: string[];
}

export interface ExecuteOneToolCallResult {
	execution: ToolExecution;
	/**
	 * Pre-constructed MessageParts (image/video/file) from
	 * execution.attachedMediaIds, ready for appendage to the
	 * tool_result part by the caller. Empty when no media was
	 * generated or none was found for the user.
	 * Callers must still call `linkMessageMedia(toolMsgId, mediaId)`
	 * for each entry in execution.attachedMediaIds separately.
	 */
	mediaParts: MessagePart[];
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
	if (toolCallParts.length === 0)
		return { toolMessages: [], pendingCount: 0, activatedToolNames: [] };

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
			const result = await runOneTool(part, params, signal);
			return {
				part,
				kind: 'completed' as const,
				execution: result.execution,
				mediaParts: result.mediaParts,
			};
		}),
	);

	// Persist results serially so created_at strictly orders the rows.
	// Tree shape: each tool message chains to the previous tool result
	// (the first chains to the assistant message), forming a linear chain
	// that walkActiveBranch can traverse leaf→root. The active_leaf moves
	// to whichever was persisted last (= last in tool-call order). The
	// next iteration's upstream call parents to that same active_leaf
	// when the loop continues.
	const toolMessages: ChatMessage[] = [];
	const activatedToolNames: string[] = [];
	let pendingCount = 0;
	for (const entry of settled) {
		const part = entry.part;
		// Pending rows carry `status: 'pending_approval'` + empty result;
		// completed rows omit the status field to stay byte-identical with
		// the pre-approval shape (read defenses default absent → completed).
		// A completed search_tools result also persists `activatedToolNames` so
		// a later turn's branch scan can re-load those tools (conversation-
		// persistent loading).
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
						...(entry.execution.activatedToolNames?.length
							? { activatedToolNames: entry.execution.activatedToolNames }
							: {}),
					};
		if (entry.kind === 'pending') pendingCount++;
		if (entry.kind === 'completed' && entry.execution.activatedToolNames?.length) {
			activatedToolNames.push(...entry.execution.activatedToolNames);
		}
		const toolMsg = appendMessage({
			conversationId: params.conversationId,
			parentMessageId: toolMessages[toolMessages.length - 1]?.id ?? params.assistantMessage.id,
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
		// Media MessageParts were pre-constructed by executeOneToolCall
		// (shared by both the inline and approval-resume paths) so we
		// just need to link and update here.
		if (entry.kind === 'completed' && entry.execution.attachedMediaIds?.length) {
			for (const mediaId of entry.execution.attachedMediaIds) {
				linkMessageMedia(toolMsg.id, mediaId);
			}
			if (entry.mediaParts.length > 0) {
				updateMessageParts(toolMsg.id, params.conversationId, [partPayload, ...entry.mediaParts]);
				// Reflect the persisted change on the in-memory ChatMessage
				// the relay returns to its callers, so the very next
				// branch-walk after this turn sees the file parts too.
				toolMsg.parts = [partPayload, ...entry.mediaParts];
			}
		}
		toolMessages.push(toolMsg);
	}

	if (toolMessages.length > 0) {
		setActiveLeafMessageId(params.conversationId, toolMessages[toolMessages.length - 1].id);
	}

	return { toolMessages, pendingCount, activatedToolNames };
}

/**
 * Execute a single tool call, encapsulating registry lookup,
 * JSON argument parsing, timeout wrapping, execution, error
 * shaping (timeout-vs-throw), and media-part construction.
 *
 * Does NOT emit SSE events or persist anything — those are the
 * caller's responsibility. This is the shared core for both the
 * inline tool-execution path and the approval-resume path.
 */
export async function executeOneToolCall(
	part: Extract<MessagePart, { type: 'tool_call' }>,
	userId: string,
	conversationId: string,
	signal: AbortSignal,
	disabledFeatures: readonly import('$lib/types/api').FeatureCategory[],
): Promise<ExecuteOneToolCallResult> {
	const tool = getTool(part.toolName);
	if (!tool) {
		return {
			execution: {
				content: JSON.stringify({ error: `Unknown tool: ${part.toolName}` }),
				isError: true,
			},
			mediaParts: [],
		};
	}

	let args: unknown = {};
	if (part.arguments.length > 0) {
		try {
			args = JSON.parse(part.arguments);
		} catch (e) {
			return {
				execution: {
					content: JSON.stringify({
						error: `Tool arguments did not parse as JSON: ${e instanceof Error ? e.message : String(e)}`,
					}),
					isError: true,
				},
				mediaParts: [],
			};
		}
	}

	const timeoutMs = tool.timeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS;
	const timeoutSignal = AbortSignal.timeout(timeoutMs);
	const combinedSignal = AbortSignal.any([signal, timeoutSignal]);

	let execution: ToolExecution;
	try {
		execution = await Promise.resolve(
			tool.execute(args, {
				userId,
				conversationId,
				signal: combinedSignal,
				disabledFeatures,
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

	// Construct media parts from attachedMediaIds so callers (inline
	// and approval-resume) don't duplicate this shaping.
	const mediaParts: MessagePart[] = [];
	if (execution.attachedMediaIds) {
		for (const mediaId of execution.attachedMediaIds) {
			const m = getMediaForUser(mediaId, userId);
			if (!m) continue;
			if (m.kind === 'image') {
				mediaParts.push({ type: 'image', mediaId });
			} else if (m.kind === 'video') {
				mediaParts.push({ type: 'video', mediaId });
			} else {
				mediaParts.push({
					type: 'file',
					mediaId,
					filename: m.originalFilename ?? mediaId,
					byteSize: m.byteSize,
				});
			}
		}
	}

	return { execution, mediaParts };
}

interface SettledToolExecution {
	part: Extract<MessagePart, { type: 'tool_call' }>;
	execution: ToolExecution;
	mediaParts: MessagePart[];
}

async function runOneTool(
	part: Extract<MessagePart, { type: 'tool_call' }>,
	params: ExecuteToolCallsParams,
	signal: AbortSignal,
): Promise<SettledToolExecution> {
	params.emit({ type: 'tool_call_executing', toolCallId: part.toolCallId });

	const { execution, mediaParts } = await executeOneToolCall(
		part,
		params.userId,
		params.conversationId,
		signal,
		params.disabledFeatures ?? [],
	);

	params.emit({
		type: 'tool_call_result',
		toolCallId: part.toolCallId,
		result: execution.content,
		isError: execution.isError === true,
	});
	return { part, execution, mediaParts };
}
