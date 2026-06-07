/**
 * Async video generation relay. Sora-shape:
 *   1. POST /v1/videos -> { id, status: "queued" }
 *   2. Poll GET /v1/videos/{id} until status === "completed" | "failed"
 *   3. GET /v1/videos/{id}/content -> mp4 bytes -> persist via MediaStore
 *
 * The polling loop runs server-side; we surface progress to the client over
 * SSE so the in-flight bubble can show "Generating video · 47% · 32.5s"
 * instead of just a ticking timer.
 *
 * Like chat streaming, this runs the recorder branch independently of the
 * client connection: a client disconnect mid-poll doesn't abort the job,
 * so the assistant message still lands on the active branch.
 */

import { Buffer } from 'node:buffer';
import { linkMessageMedia } from '../db/queries/media';
import { appendMessage, deleteBranch } from '../db/queries/messages';
import {
	videoCancel,
	videoCreate,
	videoFetchContent,
	videoStatus,
	type VideoCreateRequest,
	type VideoJob,
} from '../endpoints/client';
import { acquireEndpointSlot, type EndpointSlot } from '../endpoints/concurrency';
import { errorMessage, isAbortError, sseWriter } from './sse-transport';
import { parseModelId } from '../endpoints/model-id';
import type { LoadedEndpoint } from '../endpoints/config';
import { logLevel } from '../env';
import { persistGeneratedVideo } from '../media/persister';
import { notifyConversationComplete } from '../push/notify';
import { raceTitle, startTitleTaskIfFirstExchange } from '../tasks/title-task-runner';
import type {
	ChatMessage,
	StreamDoneEvent,
	StreamErrorEvent,
	StreamEvent,
	StreamProgressEvent,
	StreamStartEvent,
	StreamTitleEvent,
} from '$lib/types/api';

const DEBUG = logLevel() === 'debug';

// Polling cadence: starts tight so the first status flip surfaces fast,
// then backs off by 50% per tick to a 3s ceiling so a 10-minute job
// doesn't burn 400 requests at 1.5s each. 3s is the user-perceived
// ceiling — past that the progress bar starts to feel stuck even when
// the job is still running cleanly.
const MIN_POLL_INTERVAL_MS = 1500;
const MAX_POLL_INTERVAL_MS = 3000;
const MAX_WAIT_MS = 20 * 60_000; // 20 minutes — generous; rate-limited by upstream timeouts anyway
// Shorter than the chat-stream budget because the video title task
// starts when the *video job is created*, not when it finishes — so it's
// already had the full 30s+ of video generation to run by the time we
// hit the race. Under almost any task model this means the title is
// already resolved when we get here.
const TITLE_DELIVERY_BUDGET_MS = 5_000;

export interface VideoRelayParams {
	conversationId: string;
	userId: string;
	/** Conversation title at request time, used as the notification
	 *  title. May be a fallback "first-N-chars" preview. */
	conversationTitle: string | null;
	endpoint: LoadedEndpoint;
	storedModelId: string;
	prompt: string;
	userMessage: ChatMessage;
	/**
	 * Optional I2V reference image — bytes loaded server-side from an
	 * attached media row. The relay forwards them as the `input_reference`
	 * multipart field on POST /v1/videos.
	 */
	inputReference?: { bytes: Buffer; contentType: string };
	/** Media id of the I2V input image (the `inputReference`'s source row), so
	 *  the persisted video records its provenance for the split grid. */
	sourceMediaId?: string | null;
	abortSignal?: AbortSignal;
	/**
	 * Fires once the relay has truly finished (job completed, failed, or
	 * cancelled) — the route uses it to clear the in-flight registry slot.
	 * Decoupled from the client SSE lifetime on purpose: an iOS suspension
	 * cancels the response stream but the polling loop keeps running, and
	 * the registry needs to keep reflecting "is a generation still
	 * happening server-side?" so the chat page's recovery indicator can
	 * hydrate when the user comes back.
	 */
	onComplete: () => void;
	/**
	 * Fires with the bridge-side job id as soon as POST /v1/videos returns,
	 * so the route can stash it on the in-flight entry for cancellation
	 * (DELETE /v1/videos/{id}). Keeps this relay decoupled from the in-flight
	 * registry's keying — the route owns which entry to update.
	 */
	onJobId?: (jobId: string) => void;
	/** Fan-out branch: persist the video as a sibling without advancing the
	 *  conversation's active_leaf (default true = advance). */
	advanceActiveLeaf?: boolean;
	/** Skip the first-exchange title task (a fan-out runs it once in /prepare
	 *  rather than per branch). Default false. */
	suppressTitleTask?: boolean;
	/** Fires when generation begins (slot acquired) — the route stamps the
	 *  in-flight entry so a recovered fan-out shows a per-branch timer. */
	onStarted?: () => void;
	/** Fan-out regenerate: the old sibling this branch replaces, deleted
	 *  server-side once the re-roll persists (survives a refresh mid-re-roll). */
	replacesMessageId?: string | null;
}

export function startVideoRelay(params: VideoRelayParams): ReadableStream<Uint8Array> {
	return new ReadableStream({
		async start(controller) {
			const { write: safeWrite, close: safeClose } = sseWriter(controller);
			let slot: EndpointSlot | null = null;

			try {
				// Hold a per-endpoint concurrency slot across the whole poll loop
				// — a single-slot bridge runs one ComfyUI workflow at a time, so
				// two video variations serialize. Emits `queued` if at capacity;
				// resolves once a slot frees. Released in the finally.
				try {
					slot = await acquireEndpointSlot(params.endpoint.id, params.endpoint.maxConcurrent, {
						signal: params.abortSignal,
						onQueued: ({ ahead }) => safeWrite({ type: 'queued', ahead }),
					});
				} catch (e) {
					// Stop clicked while queued — nothing started. Match the
					// mid-create cancellation path (surface as a cancellation,
					// not an error). No slot held, so the finally's release no-ops.
					safeWrite({
						type: 'error',
						message: isAbortError(e) || params.abortSignal?.aborted ? 'Cancelled' : errorMessage(e),
					} satisfies StreamErrorEvent);
					safeClose();
					return;
				}

				// Slot acquired → generation begins; stamp the in-flight entry so a
				// recovery rebuild can show this branch's timer (vs a still-QUEUED one).
				params.onStarted?.();
				const startEv: StreamStartEvent = {
					type: 'start',
					userMessage: params.userMessage,
					assistantMessageId: '',
				};
				safeWrite(startEv);

				// Kick off title generation in parallel with the video job. Video
				// generation typically takes 30s+; the user prompt is the
				// conversation topic for image/video modalities, so title gen
				// doesn't have to wait for the asset itself. By the time the
				// video lands, the title is almost always ready.
				const titlePromise = params.suppressTitleTask
					? Promise.resolve<string | null>(null)
					: startTitleTaskIfFirstExchange(params.conversationId);

				let job: VideoJob;
				try {
					const req: VideoCreateRequest = {
						model: parseModelId(params.storedModelId)?.upstreamId ?? params.storedModelId,
						prompt: params.prompt,
					};
					if (params.inputReference) {
						req.inputReference = params.inputReference;
					}
					if (DEBUG) {
						const refSummary = params.inputReference
							? `, input_reference=${params.inputReference.contentType}:${params.inputReference.bytes.byteLength}B`
							: '';
						console.debug(
							`[video-relay] POST /videos to ${params.endpoint.id} model=${req.model}${refSummary}`,
						);
					}
					job = await videoCreate(params.endpoint, req, params.abortSignal);
					if (DEBUG) console.debug(`[video-relay] created job`, job);
					params.onJobId?.(job.id);
				} catch (e) {
					// A Stop click mid-create aborts the upstream fetch — treat
					// it as a cancellation (matching the in-loop abort path
					// below), not an error to surface.
					if (isAbortError(e) || params.abortSignal?.aborted) {
						safeWrite({ type: 'error', message: 'Cancelled' } satisfies StreamErrorEvent);
						safeClose();
						return;
					}
					const msg = errorMessage(e);
					console.error(`[video-relay] videoCreate failed:`, msg);
					safeWrite({
						type: 'error',
						message: `Could not start video job: ${msg}`,
					} satisfies StreamErrorEvent);
					safeClose();
					return;
				}

				// Initial state
				emitProgress(safeWrite, job);

				const startedAt = Date.now();
				let pollInterval = MIN_POLL_INTERVAL_MS;
				while (job.status !== 'completed' && job.status !== 'failed') {
					// User clicked Stop — release the bridge slot via DELETE and
					// emit a cancellation error to the client. We don't persist
					// an assistant message for cancelled video jobs.
					if (params.abortSignal?.aborted) {
						if (DEBUG) console.debug(`[video-relay] cancellation observed for job ${job.id}`);
						await videoCancel(params.endpoint, job.id);
						safeWrite({ type: 'error', message: 'Cancelled' } satisfies StreamErrorEvent);
						safeClose();
						return;
					}
					if (Date.now() - startedAt > MAX_WAIT_MS) {
						safeWrite({
							type: 'error',
							message: `Video job ${job.id} did not complete within ${MAX_WAIT_MS / 60_000} minutes`,
						} satisfies StreamErrorEvent);
						safeClose();
						return;
					}
					await sleep(pollInterval);
					pollInterval = Math.min(Math.floor(pollInterval * 1.5), MAX_POLL_INTERVAL_MS);
					try {
						job = await videoStatus(params.endpoint, job.id);
						if (DEBUG)
							console.debug(
								`[video-relay] poll job=${job.id} status=${job.status} progress=${job.progress}`,
							);
					} catch (e) {
						// Transient upstream blip — keep polling unless we've burned the budget.
						console.warn(`[video-relay] poll error for job ${job.id}:`, e);
						continue;
					}
					emitProgress(safeWrite, job);
				}

				if (job.status === 'failed') {
					const msg = job.error?.message ?? 'Video generation failed';
					safeWrite({ type: 'error', message: msg } satisfies StreamErrorEvent);
					safeClose();
					return;
				}

				// status === 'completed' — fetch + persist
				let bytes: Buffer;
				let contentType: string;
				try {
					const fetched = await videoFetchContent(params.endpoint, job.id);
					bytes = fetched.bytes;
					contentType = fetched.contentType;
				} catch (e) {
					const msg = errorMessage(e);
					safeWrite({
						type: 'error',
						message: `Could not fetch video content: ${msg}`,
					} satisfies StreamErrorEvent);
					safeClose();
					return;
				}

				let assistantMessage: ChatMessage;
				try {
					const mediaId = await persistGeneratedVideo({
						userId: params.userId,
						endpoint: params.endpoint,
						sourceModel: params.storedModelId,
						prompt: params.prompt,
						bytes,
						contentType,
						sourceMediaId: params.sourceMediaId ?? null,
					});
					assistantMessage = appendMessage({
						conversationId: params.conversationId,
						parentMessageId: params.userMessage.id,
						role: 'assistant',
						parts: [{ type: 'video', mediaId }],
						modelUsed: params.storedModelId,
						rawResponseJson: JSON.stringify(job),
						advanceActiveLeaf: params.advanceActiveLeaf ?? true,
					});
					linkMessageMedia(assistantMessage.id, mediaId);
				} catch (e) {
					const msg = errorMessage(e);
					safeWrite({
						type: 'error',
						message: `Could not persist video: ${msg}`,
					} satisfies StreamErrorEvent);
					safeClose();
					return;
				}

				// Regenerate: the re-roll landed → drop the old sibling it replaced
				// (server-side so it survives a refresh mid-re-roll; best-effort;
				// skipped on failure above so restore-on-failure keeps the original).
				if (params.replacesMessageId) {
					try {
						deleteBranch(params.conversationId, params.replacesMessageId, params.userId);
					} catch (e) {
						console.warn('[video-relay] replace-delete failed:', errorMessage(e));
					}
				}

				// Multi-minute video runs are the canonical case for OS
				// notifications — the user has almost certainly switched
				// apps by the time this resolves. Fire-and-forget per the
				// chat relay's pattern.
				void notifyConversationComplete({
					userId: params.userId,
					conversationId: params.conversationId,
					assistantMessageId: assistantMessage.id,
					conversationTitle: params.conversationTitle ?? 'New conversation',
					previewText: '',
					modality: 'video',
				}).catch((e) => console.warn('[video-relay] notify failed:', e));

				// Same ordering as the chat relay: emit `done` first so the
				// client's in-flight UI clears, then race the title task in
				// the background of the still-open SSE. `invalidateAll()` on
				// the client fires after the stream closes (when the title
				// arrives or the budget expires), so it reads the
				// post-title-persist DB state.
				safeWrite({ type: 'done', assistantMessage } satisfies StreamDoneEvent);

				const title = await raceTitle(titlePromise, TITLE_DELIVERY_BUDGET_MS);
				if (title) {
					safeWrite({ type: 'title', title } satisfies StreamTitleEvent);
				}

				safeClose();
			} finally {
				// Free the per-endpoint concurrency slot, then release the
				// in-flight slot — both independent of whether the client SSE
				// connection is still alive. iOS suspension cancels the response
				// stream long before videoStatus polling finishes; clearing on
				// response cancel (as the old wrapStreamCleanup did) would lose
				// the recovery indicator the chat page hydrates from this slot.
				slot?.release();
				params.onComplete();
			}
		},
	});
}

function emitProgress(write: (e: StreamEvent) => void, job: VideoJob): void {
	const ev: StreamProgressEvent = {
		type: 'progress',
		percent: typeof job.progress === 'number' ? job.progress : null,
		status: job.status,
	};
	write(ev);
}

function sleep(ms: number): Promise<void> {
	return new Promise((r) => setTimeout(r, ms));
}
