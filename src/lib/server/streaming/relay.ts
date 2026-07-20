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
	McpUnavailableServer,
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
import { acquireEndpointSlot, type EndpointSlot } from '../endpoints/concurrency';
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
import { CODE_ARG_TOOLS } from '$lib/chat-render';

// Generous budget because the SSE channel stays open *in the background*
// after `done` has already settled the in-flight UI on the client.
const TITLE_DELIVERY_BUDGET_MS = 20_000;

/** Hard safety bound on tool-loop iterations when the caller doesn't specify
 *  one. Higher than realistic reasoning chains; low enough that a runaway model
 *  can't pin the endpoint. Hit-the-bound surfaces as a user-visible error.
 *  Overridable per turn via RelayParams.maxToolLoopIterations (config-driven in
 *  the route handlers); kept here so the relay has no config dependency. */
const DEFAULT_MAX_TOOL_LOOP_ITERATIONS = 8;

const DEBUG = logLevel() === 'debug';

/**
 * Server-side pre-render of a code-shaped tool's primary argument
 * through shiki. CODE_ARG_TOOLS lives in `$lib/chat-render` so the
 * streaming view can use the same table to pick out the code for its
 * un-highlighted mid-stream `<pre>` rendering — keeps server and
 * client in sync on which tools have code args and which language to
 * render as.
 */
async function maybeRenderCodeArg(toolName: string, rawArgs: string): Promise<string | null> {
	const meta = CODE_ARG_TOOLS[toolName];
	if (!meta) return null;
	if (!rawArgs) return null;
	let parsed: unknown;
	try {
		parsed = JSON.parse(rawArgs);
	} catch {
		// Streaming may have left partial JSON on a stop/error path —
		// fall back to the raw JSON pretty-print in that case.
		return null;
	}
	if (!parsed || typeof parsed !== 'object') return null;
	const code = (parsed as Record<string, unknown>)[meta.codeField];
	if (typeof code !== 'string' || code.length === 0) return null;
	// Wrap in a fenced code block — same path assistant message bodies
	// take, so we inherit the existing shiki setup, theme, and CSS.
	const md = '```' + meta.language + '\n' + code + '\n```';
	try {
		return await renderMarkdown(md);
	} catch {
		return null;
	}
}

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
	/** Called when generation begins (slot acquired) — the route stamps the
	 *  in-flight entry so a recovered fan-out shows a per-branch timer. */
	onStarted?: () => void;
	// Note: chat fan-out is pick-one, so this relay has no regenerate path today
	// (regenerate is UI-gated to media via FanoutColumns' onRegenerate). If chat
	// regenerate is ever enabled it would be additive like the media re-roll —
	// just another sibling under the shared user message, no delete to wire up.
	/**
	 * Called between iterations of the tool loop to build the next
	 * upstream request body — the route handler injects this closure
	 * with access to the conversation context, system prompt, and
	 * media resolver so the relay doesn't have to reach back into
	 * route-handler concerns. When omitted, the relay runs at most
	 * one upstream iteration even if the model emits tool_calls
	 * (tools execute, results persist, the turn ends).
	 *
	 * `activatedToolNames` carries the deferred tools the model has searched
	 * up so far this turn (via `search_tools`); the closure resolves them to
	 * full definitions and appends them to `tools[]` so they're callable on the
	 * next iteration. The relay owns this turn state but NOT tool assembly —
	 * which lives in the route closure alongside the system prompt, per-user
	 * MCP, skills, and category filters — so it passes the set in rather than
	 * rebuilding `tools[]` itself.
	 */
	rebuildRequestBody?: (opts: { activatedToolNames: string[] }) => Promise<ChatCompletionRequest>;
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
	 * Hard cap on tool-loop iterations for this turn. The route handlers pass
	 * the config-driven value (`[tools] max_tool_loop_iterations`); omitted →
	 * `DEFAULT_MAX_TOOL_LOOP_ITERATIONS`. Passed in (not read here) to keep the
	 * relay free of config I/O and tests deterministic.
	 */
	maxToolLoopIterations?: number;
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
	/**
	 * Synthetic skill activations (the `/skill-name` command) already persisted
	 * and folded into `requestBody` before this relay started. Replayed as live
	 * SSE events at the very start of the stream (tool_call_start → executing →
	 * result), so the activation block renders in-flight, in the right place
	 * (before the model's response) — instead of popping in above the response
	 * on the turn's post-stream invalidate. Empty/undefined for normal turns.
	 */
	preActivatedToolEvents?: ReadonlyArray<{
		toolCallId: string;
		toolName: string;
		arguments: string;
		result: string;
		isError: boolean;
	}>;
	/**
	 * Whether the persisted assistant message should advance the
	 * conversation's active_leaf. Default true. A multi-model fan-out branch
	 * passes false so its sibling lands under the shared user message without
	 * stealing the leaf from the other concurrent branches — the leaf stays
	 * pinned at the user message until the user picks a winner.
	 */
	advanceActiveLeaf?: boolean;
	/**
	 * Skip the first-exchange title task. Default false. A fan-out fires N
	 * branch relays against one shared first exchange; without this each
	 * would kick off its own title generation. `/prepare` runs the title
	 * task once for the turn instead.
	 */
	suppressTitleTask?: boolean;
	/**
	 * Skip this branch's own completion push notification. Default false. An
	 * initial multi-model fan-out branch passes true so the N branches don't each
	 * notify; the route fires a single aggregate "N ready" notification when the
	 * last branch settles (see notifyFanoutCompleteIfLast). A lone regenerate
	 * leaves this false and notifies like any single generation.
	 */
	suppressNotify?: boolean;
	/**
	 * Per-user MCP servers enabled for this conversation but currently down
	 * (circuit-broken `failed` state). Emitted once as an `mcp_unavailable`
	 * event right after `start`, so the client can show an inline notice that
	 * the turn ran without those servers' tools. Empty/undefined for the
	 * normal case (every enabled server usable, or no per-user MCP at all).
	 */
	unavailableMcpServers?: McpUnavailableServer[];
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
			let slot: EndpointSlot | null = null;
			try {
				// Hold a per-endpoint concurrency slot for the WHOLE turn (all
				// iterations + tool execution + persistence), so a single-GPU
				// backend serializes instead of thrashing VRAM. Emits `queued`
				// when the endpoint is at capacity; the await resolves once a
				// slot frees. Released in the finally alongside onComplete.
				slot = await acquireEndpointSlot(params.endpoint.id, params.endpoint.maxConcurrent, {
					signal: params.abortSignal,
					onQueued: ({ ahead }) => write({ type: 'queued', ahead }),
				});
				// Slot acquired → generation begins; stamp the in-flight entry so a
				// recovered fan-out shows this branch's timer (vs a still-QUEUED one).
				params.onStarted?.();
				// Replay any pre-stream skill activations as live tool events so the
				// block renders in-flight before the response (the rows are already
				// persisted + in requestBody; this is purely the live-render echo).
				for (const ev of params.preActivatedToolEvents ?? []) {
					write({ type: 'tool_call_start', toolCallId: ev.toolCallId, toolName: ev.toolName });
					if (ev.arguments) {
						write({
							type: 'tool_call_args_delta',
							toolCallId: ev.toolCallId,
							argumentsDelta: ev.arguments,
						});
					}
					write({ type: 'tool_call_executing', toolCallId: ev.toolCallId });
					write({
						type: 'tool_call_result',
						toolCallId: ev.toolCallId,
						result: ev.result,
						isError: ev.isError,
					});
				}
				// Pass a release hook so the slot is freed the moment generation
				// completes — BEFORE the post-`done` title race — instead of being
				// pinned for up to TITLE_DELIVERY_BUDGET_MS while a title trickles in.
				// On a single-GPU (max_concurrent=1) endpoint that title wait would
				// otherwise block the next generation. The finally's slot?.release()
				// stays as an idempotent backstop for the error / early-return paths.
				await runChatTurn(params, write, () => slot?.release());
			} catch (err) {
				// runChatTurn handles its own upstream errors internally; the
				// only thing that throws out here is the slot acquisition being
				// aborted (user clicked Stop while queued). Nothing ran, so no
				// assistant row — close quietly on abort, surface anything else.
				if (!isAbortError(err)) {
					write({ type: 'error', message: errorMessage(err) });
				}
			} finally {
				slot?.release();
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
async function runChatTurn(
	params: RelayParams,
	write: SseWriter['write'],
	releaseSlot?: () => void,
): Promise<void> {
	// Tell the client about the user message id immediately so it can
	// reconcile its optimistic render before the assistant text starts.
	const startEvent: StreamStartEvent = {
		type: 'start',
		userMessage: params.userMessage,
		assistantMessageId: '',
	};
	write(startEvent);

	// Tell the client up front if any conversation-enabled per-user MCP server
	// is down — its tools were circuit-broken out of this turn, so the inline
	// notice explains why those tools aren't available rather than failing
	// silently. Emitted once, right after `start`.
	if (params.unavailableMcpServers && params.unavailableMcpServers.length > 0) {
		write({ type: 'mcp_unavailable', servers: params.unavailableMcpServers });
	}

	let titlePromise: Promise<string | null> | null = null;
	let finalAssistantMessage: ChatMessage | null = null;
	let finalTextPreview = '';
	let stoppedFinal = false;
	let currentRequestBody = params.requestBody;
	let parentMessageId = params.initialParentMessageId ?? params.userMessage.id;
	const maxIterations = params.maxToolLoopIterations ?? DEFAULT_MAX_TOOL_LOOP_ITERATIONS;
	// Deferred tools the model searches up this turn, accumulated so each
	// rebuild re-includes ALL of them (a tool found in iteration 1 stays in
	// tools[] for iterations 2..N). Persisted on the search_tools result rows
	// too, so the next turn's branch scan seeds them again.
	const activatedTools = new Set<string>();

	try {
		for (let iter = 0; iter < maxIterations; iter++) {
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
			// the race conditional clean. Fan-out suppresses it entirely — its
			// N concurrent branches would each start a task against the same
			// first exchange, so /prepare owns title generation once instead.
			if (titlePromise === null && !params.suppressTitleTask) {
				titlePromise = startTitleTaskIfFirstExchange(params.conversationId, params.userId);
			}

			const hasToolCalls =
				iterationResult.assistantMessage.finishReason === 'tool_calls' &&
				iterationResult.assistantMessage.parts.some((p) => p.type === 'tool_call');

			if (!hasToolCalls || stoppedFinal) break;

			// Execute tools. The persisted role:'tool' children become the
			// new active leaf — that's where the next iteration's upstream
			// call gets parented.
			const { toolMessages, pendingCount, activatedToolNames } = await executeToolCalls({
				assistantMessage: iterationResult.assistantMessage,
				conversationId: params.conversationId,
				userId: params.userId,
				signal: params.abortSignal,
				disabledFeatures: params.disabledFeatures,
				emit: write,
				needsApproval: params.needsApproval,
			});
			for (const name of activatedToolNames) activatedTools.add(name);
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
			if (iter === maxIterations - 1) {
				write({
					type: 'error',
					message: `Tool loop exceeded the safety bound (${maxIterations} iterations). The model kept emitting tool_calls; results are persisted but the conversation may be incomplete.`,
				});
				break;
			}

			try {
				currentRequestBody = await params.rebuildRequestBody({
					activatedToolNames: [...activatedTools],
				});
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
			// iteration. Same skip-on-cancel semantics as before. A fan-out
			// branch suppresses its own (the route sends one aggregate instead).
			if (
				!params.suppressNotify &&
				!stoppedFinal &&
				finalAssistantMessage.finishReason !== 'cancelled'
			) {
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

		// Generation + tools + persistence are done — free the endpoint slot NOW,
		// before we sit on the title race. This release is REQUIRED, not an
		// optimization: the title task acquires the SAME endpoint gate (see
		// callTaskModel), so on a single-GPU (max_concurrent=1) endpoint where the
		// task model shares this endpoint, holding the slot across the race would
		// deadlock the title task out entirely — it could never be granted, and
		// raceTitle would burn its whole budget while the next queued generation
		// waits it out. Do NOT move this back below the race.
		releaseSlot?.();

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
 * Persist a durable error assistant sibling on a GENUINE (non-abort) upstream
 * failure, so a fan-out branch recovered after a client disconnect (iOS suspend)
 * still shows the failed column instead of silently vanishing — the relay's
 * `finally` clears the in-flight slot, so without a persisted row the branch
 * leaves no trace. Mirrors the media relay's error-sibling. A user Stop persists
 * nothing (matching the recorder's cancelled semantics). `advanceActiveLeaf`
 * follows params: a fan-out branch stays a pinned sibling; a single send advances
 * the leaf so the failure shows in the thread on reload.
 */
function persistTurnErrorSibling(
	params: RelayParams,
	parentMessageId: string,
	message: string,
	err: unknown,
): void {
	if (isAbortError(err) || params.abortSignal?.aborted) return;
	try {
		appendMessage({
			conversationId: params.conversationId,
			parentMessageId,
			role: 'assistant',
			parts: [{ type: 'error', message }],
			modelUsed: params.storedModelId,
			advanceActiveLeaf: params.advanceActiveLeaf ?? true,
		});
	} catch (e) {
		console.warn('[stream/relay] failed to persist error sibling:', errorMessage(e));
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
		const message = errorMessage(e);
		write({ type: 'error', message });
		persistTurnErrorSibling(params, parentMessageId, message, e);
		return null;
	}

	if (!upstreamResponse.body) {
		const message = `Upstream "${params.endpoint.id}" returned no body`;
		write({ type: 'error', message });
		persistTurnErrorSibling(params, parentMessageId, message, null);
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
		const message = `Persistence failed: ${errorMessage(e)}`;
		write({ type: 'error', message });
		persistTurnErrorSibling(params, parentMessageId, message, e);
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
	// Throughput timing: wall-clock of the first and last content (text or
	// reasoning) delta. We measure first→last rather than request→last so the
	// rate excludes time-to-first-token (prefill/queue latency). Tool-call
	// gaps don't pollute this — each tool-loop iteration persists its own row,
	// so a single message spans one contiguous generation.
	let firstContentAt: number | null = null;
	let lastContentAt: number | null = null;
	// Source-measured generation time, when the upstream reports one (e.g.
	// llama.cpp's timings.predicted_ms). Preferred over the wall-clock span.
	let upstreamGenMs: number | null = null;

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
			if (result.upstreamGenMs !== undefined) upstreamGenMs = result.upstreamGenMs;
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
		// For tools whose primary argument is source code (today:
		// run_python's `code` parameter), pre-render that code through
		// the same shiki-backed markdown pipeline that produces
		// contentHtml. The renderer prefers `argsHtml` over the raw JSON
		// args when present, so the persisted view reads as syntax-
		// highlighted Python instead of a stringified JSON blob. Safe to
		// no-op silently — JSON parse failure, missing field, unknown
		// tool, render error: each path falls back to the un-highlighted
		// JSON args via the absent field.
		const argsHtml = await maybeRenderCodeArg(tc.name, tc.args);
		parts.push({
			type: 'tool_call',
			toolCallId: tc.id,
			toolName: tc.name,
			arguments: tc.args,
			...(argsHtml ? { argsHtml } : {}),
		});
	}
	const contentHtml = await renderMarkdown(textBuf);
	// Prefer the upstream's own decode-time when it reported one — it's
	// source-measured, excluding the network transit our wall-clock includes.
	// Otherwise fall back to the wall-clock span: only a positive span across
	// ≥2 content deltas yields a meaningful rate; a single-chunk response has
	// no measurable throughput, so leave it null.
	const wallClockGenMs =
		firstContentAt !== null && lastContentAt !== null && lastContentAt > firstContentAt
			? lastContentAt - firstContentAt
			: null;
	const genMs = upstreamGenMs !== null ? Math.round(upstreamGenMs) : wallClockGenMs;
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
		genMs,
		advanceActiveLeaf: params.advanceActiveLeaf ?? true,
	});

	return { assistantMessage, textForPushPreview: textBuf, stopped };

	function applyDeltas(deltas: NormalizedDelta[]) {
		for (const d of deltas) {
			if (d.type === 'text' || d.type === 'reasoning') {
				const at = Date.now();
				if (firstContentAt === null) firstContentAt = at;
				lastContentAt = at;
			}
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
