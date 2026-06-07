/**
 * Streaming image-generation relay. The single-image path (single-mode send)
 * is a plain synchronous POST → JSON; this SSE variant exists for multi-model
 * fan-out, where N image branches share one per-endpoint concurrency slot. A
 * single-GPU ComfyUI bridge runs one workflow at a time, so the branches
 * serialize — and the sync path can't tell the client which branch is actually
 * generating vs. waiting for a slot (every box just reads "Generating…").
 *
 * Streaming fixes that: it emits `queued` (with how many are ahead) while it
 * waits on the gate, `start` the moment it acquires the slot and begins
 * generating, then `done` with the persisted assistant message. The client
 * renders a QUEUED badge for waiting branches and an elapsed timer on the one
 * that's live — matching single-image generation.
 *
 * Like the chat/video relays, the recorder runs independently of the client
 * connection: a disconnect mid-generation doesn't abort the work, so the image
 * still lands on the parked fan-out and the recovery flow picks it up.
 */

import { linkMessageMedia } from '../db/queries/media';
import { appendMessage } from '../db/queries/messages';
import { imageEdit, imageGeneration, type ImageEditInputFile } from '../endpoints/client';
import { acquireEndpointSlot, type EndpointSlot } from '../endpoints/concurrency';
import type { LoadedEndpoint } from '../endpoints/config';
import { logLevel } from '../env';
import { loadMediaBytes } from '../media/data-url';
import { persistGeneratedImage } from '../media/persister';
import { notifyConversationComplete } from '../push/notify';
import { raceTitle, startTitleTaskIfFirstExchange } from '../tasks/title-task-runner';
import { errorMessage, isAbortError, sseWriter } from './sse-transport';
import type {
	ChatMessage,
	StreamDoneEvent,
	StreamErrorEvent,
	StreamStartEvent,
	StreamTitleEvent,
} from '$lib/types/api';

const DEBUG = logLevel() === 'debug';
// Title gen has been running since image generation started (the prompt is the
// topic), so it's almost always ready by the time the image lands — a short
// budget keeps a slow task model from delaying the `done`.
const TITLE_DELIVERY_BUDGET_MS = 5_000;

export interface ImageRelayParams {
	conversationId: string;
	userId: string;
	conversationTitle: string | null;
	endpoint: LoadedEndpoint;
	/** The conversation-facing model id (recorded via modelUsed). */
	storedModelId: string;
	/** The bare upstream model id sent to the endpoint. */
	upstreamModelId: string;
	prompt: string;
	userMessage: ChatMessage;
	/** Image ids to forward as i2i input (empty = text-to-image). */
	dispatchMediaIds: string[];
	/** Provenance: the (first) input image, for the split grid. Null for t2i. */
	sourceMediaId: string | null;
	abortSignal?: AbortSignal;
	/** Fan-out branch: persist as a sibling without advancing active_leaf. */
	advanceActiveLeaf?: boolean;
	/** Skip the first-exchange title task (a fan-out runs it once in /prepare). */
	suppressTitleTask?: boolean;
	/** Fires when generation actually begins (slot acquired) — the route stamps
	 *  the in-flight entry so a recovered fan-out can show a QUEUED vs timer
	 *  state per branch. */
	onStarted?: () => void;
	/** Fires when the relay truly finishes — the route clears the in-flight slot. */
	onComplete: () => void;
}

export function startImageRelay(params: ImageRelayParams): ReadableStream<Uint8Array> {
	return new ReadableStream({
		async start(controller) {
			const { write: safeWrite, close: safeClose } = sseWriter(controller);
			let slot: EndpointSlot | null = null;
			try {
				// Hold a per-endpoint slot across the whole generation so a
				// single-GPU backend serializes; emit `queued` while waiting.
				try {
					slot = await acquireEndpointSlot(params.endpoint.id, params.endpoint.maxConcurrent, {
						signal: params.abortSignal,
						onQueued: ({ ahead }) => safeWrite({ type: 'queued', ahead }),
					});
				} catch (e) {
					// Stop clicked while queued — nothing started; surface as a
					// cancellation. No slot held, so the finally's release no-ops.
					safeWrite({
						type: 'error',
						message: isAbortError(e) || params.abortSignal?.aborted ? 'Cancelled' : errorMessage(e),
					} satisfies StreamErrorEvent);
					safeClose();
					return;
				}

				// Slot acquired → generation begins. `start` flips the client
				// column from QUEUED to a live timer; onStarted stamps the in-flight
				// entry so a recovery rebuild can do the same.
				params.onStarted?.();
				safeWrite({
					type: 'start',
					userMessage: params.userMessage,
					assistantMessageId: '',
				} satisfies StreamStartEvent);

				const titlePromise = params.suppressTitleTask
					? Promise.resolve<string | null>(null)
					: startTitleTaskIfFirstExchange(params.conversationId);

				let assistantMessage: ChatMessage;
				try {
					// I2I when input images are attached, else T2I. Mirrors the sync
					// handler path; the bridge consumes repeated `image` fields in
					// order for multi-input ComfyUI workflows.
					let upstream;
					if (params.dispatchMediaIds.length > 0) {
						const images: ImageEditInputFile[] = [];
						for (const mid of params.dispatchMediaIds) {
							const loaded = await loadMediaBytes(mid, params.userId);
							images.push({ bytes: loaded.bytes, contentType: loaded.contentType });
						}
						upstream = await imageEdit(
							params.endpoint,
							{
								model: params.upstreamModelId,
								prompt: params.prompt,
								images,
								n: 1,
								response_format: 'url',
							},
							params.abortSignal,
						);
					} else {
						upstream = await imageGeneration(
							params.endpoint,
							{
								model: params.upstreamModelId,
								prompt: params.prompt,
								n: 1,
								response_format: 'url',
							},
							params.abortSignal,
						);
					}
					const result = upstream.data?.[0];
					if (!result || (!result.url && !result.b64_json)) {
						throw new Error('Upstream returned no image data');
					}
					const mediaId = await persistGeneratedImage({
						userId: params.userId,
						endpoint: params.endpoint,
						sourceModel: params.storedModelId,
						prompt: params.prompt,
						urlOrB64: { url: result.url, b64_json: result.b64_json },
						sourceMediaId: params.sourceMediaId,
					});
					assistantMessage = appendMessage({
						conversationId: params.conversationId,
						parentMessageId: params.userMessage.id,
						role: 'assistant',
						parts: [{ type: 'image', mediaId }],
						modelUsed: params.storedModelId,
						rawResponseJson: JSON.stringify(upstream),
						advanceActiveLeaf: params.advanceActiveLeaf ?? true,
					});
					linkMessageMedia(assistantMessage.id, mediaId);
				} catch (e) {
					// A Stop click aborts the upstream fetch — treat as a
					// cancellation (no noisy "failed" message), else surface it.
					if (isAbortError(e) || params.abortSignal?.aborted) {
						safeWrite({ type: 'error', message: 'Cancelled' } satisfies StreamErrorEvent);
					} else {
						const msg = errorMessage(e);
						if (DEBUG) console.error('[image-relay] generation failed:', msg);
						safeWrite({ type: 'error', message: msg } satisfies StreamErrorEvent);
					}
					safeClose();
					return;
				}

				void notifyConversationComplete({
					userId: params.userId,
					conversationId: params.conversationId,
					assistantMessageId: assistantMessage.id,
					conversationTitle: params.conversationTitle ?? 'New conversation',
					previewText: '',
					modality: 'image',
				}).catch((e) => console.warn('[image-relay] notify failed:', e));

				safeWrite({ type: 'done', assistantMessage } satisfies StreamDoneEvent);
				const title = await raceTitle(titlePromise, TITLE_DELIVERY_BUDGET_MS);
				if (title) safeWrite({ type: 'title', title } satisfies StreamTitleEvent);
				safeClose();
			} finally {
				slot?.release();
				params.onComplete();
			}
		},
	});
}
