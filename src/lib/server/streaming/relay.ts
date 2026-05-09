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
	StreamDoneEvent,
	StreamErrorEvent,
	StreamEvent,
	StreamReasoningEvent,
	StreamStartEvent,
	StreamTextEvent
} from '$lib/types/api';
import type { LoadedEndpoint, ProviderQuirk } from '../endpoints/config';
import {
	chatCompletionStream,
	UpstreamError,
	type ChatCompletionRequest
} from '../endpoints/client';
import { appendMessage } from '../db/queries/messages';
import { logLevel } from '../env';
import { parseSSEStream } from './sse-parser';
import { createNormalizer, type NormalizedDelta } from './normalizers';

const DEBUG = logLevel() === 'debug';

export interface RelayParams {
	conversationId: string;
	endpoint: LoadedEndpoint;
	providerQuirk: ProviderQuirk;
	requestBody: ChatCompletionRequest;
	userMessage: ChatMessage;
	storedModelId: string;
}

export async function startStreamingRelay(params: RelayParams): Promise<ReadableStream<Uint8Array>> {
	let upstreamResponse: Response;
	try {
		upstreamResponse = await chatCompletionStream(params.endpoint, params.requestBody);
	} catch (e) {
		const message = e instanceof UpstreamError ? e.message : e instanceof Error ? e.message : String(e);
		// Upstream couldn't even start — return a one-shot error stream.
		return errorOnlyStream(message, params.userMessage);
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
): Promise<ChatMessage> {
	const norm = createNormalizer(params.providerQuirk);
	let textBuf = '';
	let reasoningBuf = '';
	let finishReason: string | null = null;
	let tokensIn: number | null = null;
	let tokensOut: number | null = null;

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
	applyDeltas(norm.flush().deltas);

	const parts: MessagePart[] = [{ type: 'text', text: textBuf }];
	const assistantMessage = appendMessage({
		conversationId: params.conversationId,
		parentMessageId: params.userMessage.id,
		role: 'assistant',
		parts,
		reasoningText: reasoningBuf || null,
		finishReason,
		modelUsed: params.storedModelId,
		tokensIn,
		tokensOut
	});
	return assistantMessage;

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
	recorderPromise: Promise<ChatMessage>
): ReadableStream<Uint8Array> {
	const enc = new TextEncoder();

	return new ReadableStream({
		async start(controller) {
			const safeWrite = (event: StreamEvent) => {
				try {
					controller.enqueue(enc.encode(formatSSE(event)));
				} catch {
					// Client disconnected mid-write — recorder branch is unaffected.
				}
			};

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
				const msg = e instanceof Error ? e.message : String(e);
				const ev: StreamErrorEvent = { type: 'error', message: `Upstream stream failed: ${msg}` };
				safeWrite(ev);
			}

			// Wait for recorder to finish so we can hand the canonical persisted
			// message to the client. If the recorder fails, surface it.
			try {
				const assistantMessage = await recorderPromise;
				const done: StreamDoneEvent = { type: 'done', assistantMessage };
				safeWrite(done);
			} catch (e) {
				const msg = e instanceof Error ? e.message : String(e);
				const ev: StreamErrorEvent = { type: 'error', message: `Persistence failed: ${msg}` };
				safeWrite(ev);
			}

			try {
				controller.close();
			} catch {
				// already closed; ignore
			}
		}
	});
}

function errorOnlyStream(message: string, userMessage: ChatMessage): ReadableStream<Uint8Array> {
	const enc = new TextEncoder();
	return new ReadableStream({
		start(controller) {
			const start: StreamStartEvent = { type: 'start', userMessage, assistantMessageId: '' };
			controller.enqueue(enc.encode(formatSSE(start)));
			const err: StreamErrorEvent = { type: 'error', message };
			controller.enqueue(enc.encode(formatSSE(err)));
			controller.close();
		}
	});
}

function formatSSE(event: StreamEvent): string {
	// Use the SSE `event:` field so the client can dispatch by type cheaply.
	return `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}
