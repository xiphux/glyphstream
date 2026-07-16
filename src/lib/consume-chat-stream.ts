/**
 * Consume a server SSE response body for a streaming chat turn,
 * dispatching each parsed StreamEvent to the supplied callbacks.
 *
 * Lives separately from the chat page so the event-loop semantics can be
 * unit-tested in isolation — the page used to inline this and any change
 * to event handling required spinning up an actual chat. The function
 * stays deliberately UI-agnostic: callers decide what each event does
 * (append text to a bubble, scroll, toast an error, etc.). The only
 * piece of stream semantics owned here is the `sawToolCalls`
 * accumulator that `done` reads — it informs the caller whether the
 * `done` event carries the only assistant row for the turn or just the
 * last iteration of a multi-step tool loop.
 *
 * Malformed SSE records (non-JSON `data:`) are skipped silently rather
 * than aborting the stream. The chat-page's pre-extraction behavior did
 * the same.
 */

import { readSSE } from './sse-client';
import type { CanvasVersion, ChatMessage, McpUnavailableServer, StreamEvent } from './types/api';

export interface ConsumeChatStreamCallbacks {
	/**
	 * Called before each event is dispatched. Return `false` to abandon
	 * the stream (used when the chat page navigates to a different
	 * conversation mid-turn). Defaults to "always continue" if omitted.
	 */
	shouldContinue?(): boolean;

	onStart?(userMessage: ChatMessage): void | Promise<void>;
	onText?(chunk: string): void;
	onReasoning?(chunk: string): void;
	onToolCallStart?(toolCallId: string, toolName: string): void;
	onToolCallArgsDelta?(toolCallId: string, argumentsDelta: string): void;
	/** The relay flipped a tool to 'executing'. Hook left for future UI affordances. */
	onToolCallExecuting?(toolCallId: string): void;
	onToolCallResult?(toolCallId: string, result: string, isError: boolean): void;
	onToolPendingApproval?(
		toolCallId: string,
		toolName: string,
		args: string,
		displayLabel: string | undefined,
		category: string | undefined,
	): void;
	/** A canvas edit was applied and persisted; `canvas` is the new full state.
	 *  Drives the live side-by-side pane (rehydrated from the DB on reload). */
	onCanvasVersion?(canvas: CanvasVersion): void;
	onProgress?(percent: number | null, status: string | null): void;
	/** The request is waiting for a per-endpoint concurrency slot. Fires at
	 *  most once, before any generation events; the next real event signals
	 *  the slot was granted. `ahead` is how many generations are in line first. */
	onQueued?(ahead: number): void;
	/** One or more per-user MCP servers enabled for this conversation are down;
	 *  their tools were skipped this turn. Fires at most once, near the start. */
	onMcpUnavailable?(servers: McpUnavailableServer[]): void;
	onTitle?(title: string): void;
	/** Compaction summarization started — show the in-flight summary block. */
	onCompactionStart?(): void;
	/** A chunk of the streaming summary text. */
	onCompactionText?(chunk: string): void;
	/** The summary was persisted; `summaryMessage` is the canonical row. */
	onCompactionDone?(summaryMessage: ChatMessage): void | Promise<void>;
	/** Fires on the canonical `done` frame. `sawToolCalls` is true when the
	 *  turn ran the multi-iteration tool loop and the assistantMessage is
	 *  just the LAST iteration's row (intermediate rows arrive via invalidate). */
	onDone?(args: { assistantMessage: ChatMessage; sawToolCalls: boolean }): void;
	onError?(message: string): void;
}

export interface ConsumeChatStreamResult {
	sawToolCalls: boolean;
}

export async function consumeChatStream(
	body: ReadableStream<Uint8Array>,
	cb: ConsumeChatStreamCallbacks,
): Promise<ConsumeChatStreamResult> {
	let sawToolCalls = false;
	for await (const rec of readSSE(body)) {
		if (cb.shouldContinue && !cb.shouldContinue()) break;
		let event: StreamEvent;
		try {
			event = JSON.parse(rec.data) as StreamEvent;
		} catch {
			continue;
		}
		switch (event.type) {
			case 'start':
				await cb.onStart?.(event.userMessage);
				break;
			case 'text':
				cb.onText?.(event.chunk);
				break;
			case 'reasoning':
				cb.onReasoning?.(event.chunk);
				break;
			case 'tool_call_start':
				// By the time the model emits a tool_call_start it has
				// committed to that branch, so flip the flag unconditionally
				// — the `done` handler reads it to decide whether to
				// optimistically append the final assistant message or
				// wait for invalidate to land all intermediate rows.
				sawToolCalls = true;
				cb.onToolCallStart?.(event.toolCallId, event.toolName);
				break;
			case 'tool_call_args_delta':
				cb.onToolCallArgsDelta?.(event.toolCallId, event.argumentsDelta);
				break;
			case 'tool_call_executing':
				cb.onToolCallExecuting?.(event.toolCallId);
				break;
			case 'tool_call_result':
				cb.onToolCallResult?.(event.toolCallId, event.result, event.isError);
				break;
			case 'tool_pending_approval':
				// Same reasoning as tool_call_start — the loop ran, even
				// though the tool itself didn't execute yet.
				sawToolCalls = true;
				cb.onToolPendingApproval?.(
					event.toolCallId,
					event.toolName,
					event.args,
					event.displayLabel,
					event.category,
				);
				break;
			case 'canvas_version':
				cb.onCanvasVersion?.(event.canvas);
				break;
			case 'progress':
				cb.onProgress?.(event.percent, event.status ?? null);
				break;
			case 'queued':
				cb.onQueued?.(event.ahead);
				break;
			case 'mcp_unavailable':
				cb.onMcpUnavailable?.(event.servers);
				break;
			case 'title':
				cb.onTitle?.(event.title);
				break;
			case 'compaction_start':
				cb.onCompactionStart?.();
				break;
			case 'compaction_text':
				cb.onCompactionText?.(event.chunk);
				break;
			case 'compaction_done':
				await cb.onCompactionDone?.(event.summaryMessage);
				break;
			case 'done':
				cb.onDone?.({ assistantMessage: event.assistantMessage, sawToolCalls });
				break;
			case 'error':
				cb.onError?.(event.message);
				break;
		}
	}
	return { sawToolCalls };
}
