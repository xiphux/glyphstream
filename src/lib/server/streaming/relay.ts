/**
 * Streaming chat relay. Calls the upstream with stream=true, tees the
 * response into:
 *   1. a "to-client" branch — parses SSE, normalizes per provider quirk,
 *      writes our own normalized SSE to a ReadableStream the SvelteKit
 *      route returns to the browser
 *   2. a "to-recorder" branch — independently parses, normalizes, and
 *      persists the assistant message at end-of-stream
 *
 * Both branches run independently. If the client disconnects mid-stream,
 * the recorder still finishes and the message is saved. This is the
 * "survive flaky connections" promise from the design doc.
 */

import type {
	ChatMessage,
	MessagePart,
	ModelKind,
	StreamDoneEvent,
	StreamErrorEvent,
	StreamReasoningEvent,
	StreamStartEvent,
	StreamTextEvent,
	StreamTitleEvent
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
import { errorMessage, isAbortError, sseWriter } from './sse-transport';

// Generous budget because the SSE channel stays open *in the background*
// after `done` has already settled the in-flight UI on the client. The
// budget caps how long we'll hold the connection waiting for a slow task
// model; under it the title arrives in-band via a `title` event, over it
// the title still lands in the DB (the task runs to completion) but the
// client only sees it on the next sidebar refetch / navigation.
// Sized to comfortably cover a beefy task model — e.g., 26B-class
// llama.cpp models can spend ~5s on prompt eval alone for a "user +
// assistant" title prompt before generating a single token.
const TITLE_DELIVERY_BUDGET_MS = 20_000;

const DEBUG = logLevel() === 'debug';

/** Map the conversation's snapshotted model kind onto the notify
 *  payload's modality, defaulting null to 'chat'. Kept local because
 *  the type-narrowing is shallow and only one caller needs it. */
function relayModalityFor(kind: ModelKind | null): NotifyModality {
	if (kind === 'image' || kind === 'video' || kind === 'embedding') return kind;
	return 'chat';
}

export interface RelayParams {
	conversationId: string;
	/** Owner of the conversation, for routing push notifications. */
	userId: string;
	/** Conversation title at request time, used as the notification
	 *  title. May be a fallback "first-N-chars" preview; the AI title
	 *  may land later but won't reshape an already-sent notification. */
	conversationTitle: string | null;
	/** Snapshotted on the conversation row; threaded through so the
	 *  notify payload's `modality` field reflects what was actually
	 *  generated (chat vs. image vs. video). */
	modelKind: ModelKind | null;
	endpoint: LoadedEndpoint;
	providerQuirk: ProviderQuirk;
	requestBody: ChatCompletionRequest;
	userMessage: ChatMessage;
	storedModelId: string;
	/** Aborts the upstream fetch when the user clicks Stop. */
	abortSignal?: AbortSignal;
}

interface RecorderResult {
	message: ChatMessage;
	/**
	 * Resolves to the AI-generated title when the task model produced
	 * one *and* the conditional UPDATE (`title_source = 'fallback'`)
	 * matched. Resolves to null if title gen was skipped (no task
	 * model configured, source already 'ai'/'user', upstream failure,
	 * empty/garbage response, or pre-existing rename racing us).
	 */
	titlePromise: Promise<string | null>;
}

export async function startStreamingRelay(params: RelayParams): Promise<ReadableStream<Uint8Array>> {
	let upstreamResponse: Response;
	try {
		upstreamResponse = await chatCompletionStream(
			params.endpoint,
			params.requestBody,
			params.abortSignal
		);
	} catch (e) {
		// Upstream couldn't even start — return a one-shot error stream.
		return errorOnlyStream(errorMessage(e), params.userMessage);
	}

	if (!upstreamResponse.body) {
		return errorOnlyStream('Upstream returned no body', params.userMessage);
	}

	const [forClient, forRecorder] = upstreamResponse.body.tee();

	const recorderPromise = recordAndPersist(forRecorder, params).catch((e) => {
		// Don't crash the response; the client error event is the user-visible signal.
		console.error('[stream/relay] recorder branch failed:', e);
		throw e;
	});

	return buildClientStream(forClient, params, recorderPromise);
}

/** Spawned independently from the client; persists assistant message at end. */
async function recordAndPersist(
	upstream: ReadableStream<Uint8Array>,
	params: RelayParams
): Promise<RecorderResult> {
	const norm = createNormalizer(params.providerQuirk);
	let textBuf = '';
	let reasoningBuf = '';
	let finishReason: string | null = null;
	let tokensIn: number | null = null;
	let tokensOut: number | null = null;
	let stopped = false;

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
		// User clicked Stop -> the upstream fetch was aborted -> the body
		// stream we're reading errors. Treat it as "stop here" and persist
		// whatever text we accumulated so the user keeps what they read.
		if (isAbortError(e) || params.abortSignal?.aborted) {
			stopped = true;
		} else {
			throw e;
		}
	}
	applyDeltas(norm.flush().deltas);

	const parts: MessagePart[] = [{ type: 'text', text: textBuf }];
	const contentHtml = await renderMarkdown(textBuf);
	const assistantMessage = appendMessage({
		conversationId: params.conversationId,
		parentMessageId: params.userMessage.id,
		role: 'assistant',
		parts,
		contentHtml,
		reasoningText: reasoningBuf || null,
		finishReason: stopped ? 'cancelled' : finishReason,
		modelUsed: params.storedModelId,
		tokensIn,
		tokensOut
	});

	// Fire push notifications when the stream finished cleanly. A user
	// clicking Stop is the loudest possible signal they're paying
	// attention — notifying them about a generation they just killed
	// would feel broken. Fire-and-forget: push failure must not block
	// the recorder or the SSE `done` event the client is waiting on.
	if (!stopped && finishReason !== 'cancelled') {
		void notifyConversationComplete({
			userId: params.userId,
			conversationId: params.conversationId,
			assistantMessageId: assistantMessage.id,
			conversationTitle: params.conversationTitle ?? 'New conversation',
			previewText: textBuf,
			modality: relayModalityFor(params.modelKind)
		}).catch((e) => console.warn('[stream/relay] notify failed:', e));
	}

	// Title task: fire only on the conversation's first exchange. The
	// title_source column starts at 'fallback' (default + first-message
	// preview); once the AI title lands it flips to 'ai', or 'user' on
	// rename. Both terminal states gate this branch off so subsequent
	// messages don't re-run the task. Errors swallowed inside the
	// generator — the returned promise resolves to null on any failure.
	const titlePromise = startTitleTaskIfFirstExchange(params.conversationId);

	return { message: assistantMessage, titlePromise };

	function applyDeltas(deltas: NormalizedDelta[]) {
		for (const d of deltas) {
			if (d.type === 'text') textBuf += d.text;
			else if (d.type === 'reasoning') reasoningBuf += d.text;
		}
	}
}

function buildClientStream(
	upstream: ReadableStream<Uint8Array>,
	params: RelayParams,
	recorderPromise: Promise<RecorderResult>
): ReadableStream<Uint8Array> {
	return new ReadableStream({
		async start(controller) {
			const { write: safeWrite, close: safeClose } = sseWriter(controller);

			// Tell the client about the user message id immediately so it can
			// reconcile its optimistic render before the assistant text starts.
			// We emit a placeholder assistant id of "" — the canonical row id
			// arrives in the `done` event. (UI keys on the in-flight bubble's
			// own client-generated id during streaming.)
			const startEvent: StreamStartEvent = {
				type: 'start',
				userMessage: params.userMessage,
				assistantMessageId: ''
			};
			safeWrite(startEvent);

			const norm = createNormalizer(params.providerQuirk);
			try {
				for await (const record of parseSSEStream(upstream)) {
					const result = norm.process(record);
					for (const d of result.deltas) {
						if (d.type === 'text') {
							const ev: StreamTextEvent = { type: 'text', chunk: d.text };
							safeWrite(ev);
						} else {
							const ev: StreamReasoningEvent = { type: 'reasoning', chunk: d.text };
							safeWrite(ev);
						}
					}
					if (result.done) break;
				}
				for (const d of norm.flush().deltas) {
					if (d.type === 'text') safeWrite({ type: 'text', chunk: d.text });
					else safeWrite({ type: 'reasoning', chunk: d.text });
				}
			} catch (e) {
				// User clicked Stop -> upstream aborted -> parseSSE throws.
				// That's not a user-facing error; the recorder will commit
				// the partial text and we'll surface it via `done` below.
				if (!(isAbortError(e) || params.abortSignal?.aborted)) {
					safeWrite({
						type: 'error',
						message: `Upstream stream failed: ${errorMessage(e)}`
					} satisfies StreamErrorEvent);
				}
			}

			// Wait for recorder to finish so we can hand the canonical persisted
			// message to the client. If the recorder fails, surface it.
			try {
				const { message: assistantMessage, titlePromise } = await recorderPromise;

				// Emit `done` immediately — the response has truly finished
				// streaming and the client's "in-flight" indicator should
				// release now, NOT after we finish waiting on the title
				// task. Holding `done` for the title race would extend the
				// "still generating" UI state by however long the task
				// model takes, which feels broken to the user.
				const done: StreamDoneEvent = { type: 'done', assistantMessage };
				safeWrite(done);

				// Then race the title task in the background. The SSE stream
				// stays open until either the title arrives or the budget
				// expires; the client's for-await loop keeps reading and
				// only fires `invalidateAll()` once the stream closes. That
				// timing is load-bearing: it ensures the load function
				// reads the *post-title-persist* DB state, so the sidebar
				// catches the AI title even though we already sent `done`.
				const title = await raceTitle(titlePromise, TITLE_DELIVERY_BUDGET_MS);
				if (title) {
					safeWrite({ type: 'title', title } satisfies StreamTitleEvent);
				}
			} catch (e) {
				const ev: StreamErrorEvent = {
					type: 'error',
					message: `Persistence failed: ${errorMessage(e)}`
				};
				safeWrite(ev);
			}

			safeClose();
		}
	});
}

function errorOnlyStream(message: string, userMessage: ChatMessage): ReadableStream<Uint8Array> {
	return new ReadableStream({
		start(controller) {
			const sse = sseWriter(controller);
			sse.write({ type: 'start', userMessage, assistantMessageId: '' });
			sse.write({ type: 'error', message });
			sse.close();
		}
	});
}
