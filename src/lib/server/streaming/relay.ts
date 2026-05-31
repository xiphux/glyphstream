/**
 * Streaming chat relay. Drives the upstream chat-completion loop:
 *
 *   for each iteration (up to MAX_ITER):
 *     1. POST /chat/completions with stream=true and (current) messages
 *     2. tee the response into two branches:
 *        - "to-client": parse + normalize + forward as our SSE events
 *        - "to-recorder": parse + normalize + persist the assistant row
 *     3. await both branches to finish
 *     4. if finish_reason !== 'tool_calls' → emit `done`, exit loop
 *     5. otherwise, execute every tool_call, persist results as
 *        role:'tool' children, rebuild the upstream messages array
 *        from the (now-extended) branch, and loop
 *
 * The "to-recorder" branch survives a client disconnect — the
 * ReadableStream's `start()` function continues running and our
 * `sseWriter` swallows enqueue errors on a closed controller, so iOS
 * suspending the PWA mid-turn doesn't lose the assistant row or any
 * pending tool execution. The in-flight slot (`onComplete`) is held
 * for the WHOLE loop and released once in the outer `finally`.
 */

import type {
	ChatMessage,
	MessagePart,
	ModelKind,
	StreamErrorEvent,
	StreamReasoningEvent,
	StreamStartEvent,
	StreamTextEvent,
	StreamTitleEvent,
	StreamToolCallArgsDeltaEvent,
	StreamToolCallStartEvent,
} from '$lib/types/api';
import type { LoadedEndpoint, ProviderQuirk } from '../endpoints/config';
import { chatCompletionStream, type ChatCompletionRequest } from '../endpoints/client';
import { appendMessage } from '../db/queries/messages';
import { logLevel } from '../env';
import { renderMarkdown } from '../markdown/render';
import { notifyConversationComplete } from '../push/notify';
import type { NotifyModality } from '$lib/types/push';
import { raceTitle, startTitleTaskIfFirstExchange } from '../tasks/title-task-runner';
import { parseSSEStream } from './sse-parser';
import { createNormalizer, type NormalizedDelta } from './normalizers';
import { errorMessage, isAbortError, sseWriter, type SseWriter } from './sse-transport';
import { executeToolCalls } from './tool-execution';
import type { Tool } from '../tools/types';

// Generous budget because the SSE channel stays open *in the background*
// after `done` has already settled the in-flight UI on the client.
const TITLE_DELIVERY_BUDGET_MS = 20_000;

/** Hard safety bound on tool-loop iterations. Higher than realistic
 *  reasoning chains; low enough that a runaway model can't pin the
 *  endpoint. Hit-the-bound surfaces as a user-visible error. */
const MAX_TOOL_LOOP_ITERATIONS = 5;

const DEBUG = logLevel() === 'debug';

function relayModalityFor(kind: ModelKind | null): NotifyModality {
	if (kind === 'image' || kind === 'video' || kind === 'embedding') return kind;
	return 'chat';
}

export interface RelayParams {
	conversationId: string;
	/** Owner of the conversation, for routing push notifications. */
	userId: string;
	/** Conversation title at request time, used as the notification title. */
	conversationTitle: string | null;
	/** Drives the notify payload's `modality` field. */
	modelKind: ModelKind | null;
	endpoint: LoadedEndpoint;
	providerQuirk: ProviderQuirk;
	/** Initial request body for iteration 0. The relay calls
	 *  `rebuildRequestBody` to derive subsequent iterations' bodies. */
	requestBody: ChatCompletionRequest;
	userMessage: ChatMessage;
	storedModelId: string;
	/** Aborts the upstream fetch + cooperative tool execution when
	 *  the user clicks Stop. */
	abortSignal?: AbortSignal;
	/**
	 * Fires once when the whole turn is done (all iterations finished,
	 * all tools executed, message rows persisted). Decoupled from the
	 * client SSE lifetime so iOS-suspending the PWA doesn't leak the
	 * in-flight slot.
	 */
	onComplete: () => void;
	/**
	 * Called between iterations of the tool loop to build the next
	 * upstream request body — the route handler injects this closure
	 * with access to the conversation context, system prompt, and
	 * media resolver so the relay doesn't have to reach back into
	 * route-handler concerns. When omitted, the relay runs at most
	 * one upstream iteration even if the model emits tool_calls
	 * (tools execute, results persist, the turn ends).
	 */
	rebuildRequestBody?: () => Promise<ChatCompletionRequest>;
	/**
	 * Predicate forwarded to executeToolCalls so MCP tools the user
	 * hasn't granted "always allow" pause the turn for an explicit
	 * Allow / Allow Always / Reject prompt instead of executing inline.
	 * When the predicate flags any tool, the loop halts (no
	 * rebuildRequestBody call) and the stream ends with `done`; the
	 * resume endpoint takes over once the user posts decisions.
	 */
	needsApproval?: (toolName: string, tool: Tool | undefined) => boolean;
	/**
	 * Per-conversation feature-category opt-outs. Forwarded through
	 * `executeToolCalls` into each tool's `ToolContext`, so tools whose
	 * behavior depends on a non-self category (run_python checking
	 * `'web'` to gate its Python network shim) can honor the
	 * conversation's switches at execute time, not just request-build
	 * time.
	 */
	disabledFeatures?: readonly import('$lib/types/api').FeatureCategory[];
	/**
	 * Override for iteration 0's parent message. For the standard
	 * messages POST this stays undefined and the relay parents the
	 * first assistant message to `userMessage.id`. The approval-resume
	 * endpoint instead passes the current active_leaf (the last tool
	 * message from the halted turn) so the continuation lands as a
	 * child of that tool message rather than a sibling of the prior
	 * assistant — otherwise every resume forks the branch.
	 */
	initialParentMessageId?: string;
}

interface IterationResult {
	assistantMessage: ChatMessage;
	textForPushPreview: string;
	stopped: boolean;
}

export async function startStreamingRelay(
	params: RelayParams,
): Promise<ReadableStream<Uint8Array>> {
	return new ReadableStream({
		async start(controller) {
			const { write, close } = sseWriter(controller);
			try {
				await runChatTurn(params, write);
			} finally {
				params.onComplete();
				close();
			}
		},
	});
}

/**
 * Orchestrates the multi-iteration upstream loop. Emits SSE to the
 * client via `write` (which no-ops on a disconnected client). Returns
 * when the turn settles — by `finish_reason !== 'tool_calls'`, by hitting
 * MAX_TOOL_LOOP_ITERATIONS, by user abort, or by an upstream failure.
 */
async function runChatTurn(params: RelayParams, write: SseWriter['write']): Promise<void> {
	// Tell the client about the user message id immediately so it can
	// reconcile its optimistic render before the assistant text starts.
	const startEvent: StreamStartEvent = {
		type: 'start',
		userMessage: params.userMessage,
		assistantMessageId: '',
	};
	write(startEvent);

	let titlePromise: Promise<string | null> | null = null;
	let finalAssistantMessage: ChatMessage | null = null;
	let finalTextPreview = '';
	let stoppedFinal = false;
	let currentRequestBody = params.requestBody;
	let parentMessageId = params.initialParentMessageId ?? params.userMessage.id;

	try {
		for (let iter = 0; iter < MAX_TOOL_LOOP_ITERATIONS; iter++) {
			if (params.abortSignal?.aborted) {
				stoppedFinal = true;
				break;
			}

			const iterationResult = await runOneIteration({
				params,
				requestBody: currentRequestBody,
				parentMessageId,
				write,
			});
			if (!iterationResult) return; // upstream failed; error already emitted

			finalAssistantMessage = iterationResult.assistantMessage;
			finalTextPreview = iterationResult.textForPushPreview;
			stoppedFinal = iterationResult.stopped;

			// Title task fires once per conversation, on the FIRST iteration.
			// The helper itself idempotently no-ops on subsequent calls, but
			// capturing the promise here and only racing it at the end keeps
			// the race conditional clean.
			if (titlePromise === null) {
				titlePromise = startTitleTaskIfFirstExchange(params.conversationId);
			}

			const hasToolCalls =
				iterationResult.assistantMessage.finishReason === 'tool_calls' &&
				iterationResult.assistantMessage.parts.some((p) => p.type === 'tool_call');

			if (!hasToolCalls || stoppedFinal) break;

			// Execute tools. The persisted role:'tool' children become the
			// new active leaf — that's where the next iteration's upstream
			// call gets parented.
			const { toolMessages, pendingCount } = await executeToolCalls({
				assistantMessage: iterationResult.assistantMessage,
				conversationId: params.conversationId,
				userId: params.userId,
				signal: params.abortSignal,
				disabledFeatures: params.disabledFeatures,
				emit: write,
				needsApproval: params.needsApproval,
			});
			parentMessageId =
				toolMessages.length > 0
					? toolMessages[toolMessages.length - 1].id
					: iterationResult.assistantMessage.id;

			// Any pending_approval rows mean the turn halts here — the
			// resume endpoint will fill them in and continue with a fresh
			// SSE stream once the user posts decisions.
			if (pendingCount > 0) break;

			// No `rebuildRequestBody` ⇒ single-iteration mode (the caller
			// opted out of looping). Tools ran, results persisted; turn ends.
			if (!params.rebuildRequestBody) break;

			// Safety: if we've just executed tools on the LAST allowed
			// iteration, surface an error rather than silently truncating
			// the model's response.
			if (iter === MAX_TOOL_LOOP_ITERATIONS - 1) {
				write({
					type: 'error',
					message: `Tool loop exceeded the safety bound (${MAX_TOOL_LOOP_ITERATIONS} iterations). The model kept emitting tool_calls; results are persisted but the conversation may be incomplete.`,
				});
				break;
			}

			try {
				currentRequestBody = await params.rebuildRequestBody();
			} catch (e) {
				write({
					type: 'error',
					message: `Failed to rebuild request body for next iteration: ${errorMessage(e)}`,
				});
				return;
			}
		}

		// Emit `done` once, with the FINAL assistant message. The chat
		// page invalidates and refetches on `done`, which surfaces all
		// the intermediate role:'tool' rows from the loop.
		if (finalAssistantMessage) {
			write({ type: 'done', assistantMessage: finalAssistantMessage });

			// Fire push notification for the completed turn — never per
			// iteration. Same skip-on-cancel semantics as before.
			if (!stoppedFinal && finalAssistantMessage.finishReason !== 'cancelled') {
				void notifyConversationComplete({
					userId: params.userId,
					conversationId: params.conversationId,
					assistantMessageId: finalAssistantMessage.id,
					conversationTitle: params.conversationTitle ?? 'New conversation',
					previewText: finalTextPreview,
					modality: relayModalityFor(params.modelKind),
				}).catch((e) => console.warn('[stream/relay] notify failed:', e));
			}
		}

		// Race the title task in the background. The SSE stream stays
		// open until either the title arrives or the budget expires.
		if (titlePromise) {
			const title = await raceTitle(titlePromise, TITLE_DELIVERY_BUDGET_MS);
			if (title) write({ type: 'title', title } satisfies StreamTitleEvent);
		}
	} catch (e) {
		const ev: StreamErrorEvent = { type: 'error', message: errorMessage(e) };
		write(ev);
	}
}

/**
 * Run one upstream iteration: fetch, tee, drive the recorder (which
 * persists the assistant row) and the client forwarder (which streams
 * SSE events) concurrently, then await both. Returns the persisted
 * assistant message + the text preview used for push notifications.
 *
 * Returns null when the upstream itself failed; the error event is
 * already written to the client in that case.
 */
async function runOneIteration(args: {
	params: RelayParams;
	requestBody: ChatCompletionRequest;
	parentMessageId: string;
	write: SseWriter['write'];
}): Promise<IterationResult | null> {
	const { params, requestBody, parentMessageId, write } = args;
	let upstreamResponse: Response;
	try {
		upstreamResponse = await chatCompletionStream(params.endpoint, requestBody, params.abortSignal);
	} catch (e) {
		write({ type: 'error', message: errorMessage(e) });
		return null;
	}

	if (!upstreamResponse.body) {
		write({ type: 'error', message: `Upstream "${params.endpoint.id}" returned no body` });
		return null;
	}

	const [forClient, forRecorder] = upstreamResponse.body.tee();

	const recorderPromise = recordAndPersistOneIteration({
		upstream: forRecorder,
		params,
		parentMessageId,
	}).catch((e) => {
		console.error('[stream/relay] recorder branch failed:', e);
		throw e;
	});

	// Drive the client-facing branch to completion (or abort).
	try {
		const norm = createNormalizer(params.providerQuirk);
		for await (const record of parseSSEStream(forClient)) {
			const result = norm.process(record);
			for (const d of result.deltas) {
				forwardDelta(d, write);
			}
			if (result.done) break;
		}
		for (const d of norm.flush().deltas) {
			forwardDelta(d, write);
		}
	} catch (e) {
		if (!(isAbortError(e) || params.abortSignal?.aborted)) {
			write({
				type: 'error',
				message: `Upstream stream failed: ${errorMessage(e)}`,
			} satisfies StreamErrorEvent);
		}
	}

	try {
		return await recorderPromise;
	} catch (e) {
		write({ type: 'error', message: `Persistence failed: ${errorMessage(e)}` });
		return null;
	}
}

interface RecorderArgs {
	upstream: ReadableStream<Uint8Array>;
	params: RelayParams;
	parentMessageId: string;
}

/**
 * Recorder branch for a single iteration. Independently parses + normalizes
 * the upstream stream and persists an assistant message at end-of-stream.
 * Survives client disconnect (the caller's start() function keeps running).
 */
async function recordAndPersistOneIteration(args: RecorderArgs): Promise<IterationResult> {
	const { upstream, params, parentMessageId } = args;
	const norm = createNormalizer(params.providerQuirk);
	let textBuf = '';
	let reasoningBuf = '';
	let finishReason: string | null = null;
	let tokensIn: number | null = null;
	let tokensOut: number | null = null;
	let stopped = false;

	const toolCallAccum = new Map<number, { id: string; name: string; args: string }>();

	try {
		for await (const record of parseSSEStream(upstream)) {
			if (DEBUG) console.debug(`[stream/upstream] ${params.endpoint.id}:`, record.data);
			const result = norm.process(record);
			applyDeltas(result.deltas);
			if (result.finishReason) finishReason = result.finishReason;
			if (result.usage) {
				if (result.usage.promptTokens !== undefined) tokensIn = result.usage.promptTokens;
				if (result.usage.completionTokens !== undefined) tokensOut = result.usage.completionTokens;
			}
			if (result.done) break;
		}
	} catch (e) {
		if (isAbortError(e) || params.abortSignal?.aborted) {
			stopped = true;
		} else {
			throw e;
		}
	}
	applyDeltas(norm.flush().deltas);

	const parts: MessagePart[] = [{ type: 'text', text: textBuf }];
	for (const tc of toolCallAccum.values()) {
		parts.push({
			type: 'tool_call',
			toolCallId: tc.id,
			toolName: tc.name,
			arguments: tc.args,
		});
	}
	const contentHtml = await renderMarkdown(textBuf);
	const assistantMessage = appendMessage({
		conversationId: params.conversationId,
		parentMessageId,
		role: 'assistant',
		parts,
		contentHtml,
		reasoningText: reasoningBuf || null,
		finishReason: stopped ? 'cancelled' : finishReason,
		modelUsed: params.storedModelId,
		tokensIn,
		tokensOut,
	});

	return { assistantMessage, textForPushPreview: textBuf, stopped };

	function applyDeltas(deltas: NormalizedDelta[]) {
		for (const d of deltas) {
			if (d.type === 'text') textBuf += d.text;
			else if (d.type === 'reasoning') reasoningBuf += d.text;
			else if (d.type === 'tool_call_start') {
				toolCallAccum.set(d.index, {
					id: d.toolCallId,
					name: d.toolName,
					args: '',
				});
			} else if (d.type === 'tool_call_args_delta') {
				const entry = toolCallAccum.get(d.index);
				if (entry) entry.args += d.argumentsDelta;
			}
		}
	}
}

/**
 * Translate one normalized delta into the corresponding client-facing
 * SSE event. Centralized so both the upstream-streaming loop and the
 * end-of-stream flush use exactly the same mapping.
 */
function forwardDelta(d: NormalizedDelta, write: SseWriter['write']): void {
	switch (d.type) {
		case 'text': {
			const ev: StreamTextEvent = { type: 'text', chunk: d.text };
			write(ev);
			return;
		}
		case 'reasoning': {
			const ev: StreamReasoningEvent = { type: 'reasoning', chunk: d.text };
			write(ev);
			return;
		}
		case 'tool_call_start': {
			const ev: StreamToolCallStartEvent = {
				type: 'tool_call_start',
				toolCallId: d.toolCallId,
				toolName: d.toolName,
			};
			write(ev);
			return;
		}
		case 'tool_call_args_delta': {
			const ev: StreamToolCallArgsDeltaEvent = {
				type: 'tool_call_args_delta',
				toolCallId: d.toolCallId,
				argumentsDelta: d.argumentsDelta,
			};
			write(ev);
			return;
		}
	}
}
