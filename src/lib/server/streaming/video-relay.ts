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
import { appendMessage } from '../db/queries/messages';
import {
	formatUpstreamError,
	UpstreamError,
	videoCancel,
	videoCreate,
	videoFetchContent,
	videoStatus,
	type VideoCreateRequest,
	type VideoJob
} from '../endpoints/client';
import { setVideoJobId } from './in-flight';
import type { LoadedEndpoint } from '../endpoints/config';
import { logLevel } from '../env';
import { persistGeneratedVideo } from '../media/persister';
import { raceTitle, startTitleTaskIfFirstExchange } from '../tasks/title-task-runner';
import type {
	ChatMessage,
	StreamDoneEvent,
	StreamErrorEvent,
	StreamEvent,
	StreamProgressEvent,
	StreamStartEvent,
	StreamTitleEvent
} from '$lib/types/api';

const DEBUG = logLevel() === 'debug';

const POLL_INTERVAL_MS = 1500;
const MAX_WAIT_MS = 20 * 60_000; // 20 minutes — generous; rate-limited by upstream timeouts anyway
const TITLE_DELIVERY_BUDGET_MS = 5000;

export interface VideoRelayParams {
	conversationId: string;
	userId: string;
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
	abortSignal?: AbortSignal;
}

export function startVideoRelay(params: VideoRelayParams): ReadableStream<Uint8Array> {
	const enc = new TextEncoder();

	return new ReadableStream({
		async start(controller) {
			const safeWrite = (event: StreamEvent) => {
				try {
					controller.enqueue(enc.encode(formatSSE(event)));
				} catch {
					// client gone; the recorder side keeps running below
				}
			};

			const startEv: StreamStartEvent = {
				type: 'start',
				userMessage: params.userMessage,
				assistantMessageId: ''
			};
			safeWrite(startEv);

			// Kick off title generation in parallel with the video job. Video
			// generation typically takes 30s+; the user prompt is the
			// conversation topic for image/video modalities, so title gen
			// doesn't have to wait for the asset itself. By the time the
			// video lands, the title is almost always ready.
			const titlePromise = startTitleTaskIfFirstExchange(params.conversationId);

			let job: VideoJob;
			try {
				const req: VideoCreateRequest = {
					model: parseUpstreamId(params.storedModelId),
					prompt: params.prompt
				};
				if (params.inputReference) {
					req.inputReference = params.inputReference;
				}
				if (DEBUG) {
					const refSummary = params.inputReference
						? `, input_reference=${params.inputReference.contentType}:${params.inputReference.bytes.byteLength}B`
						: '';
					console.debug(
						`[video-relay] POST /videos to ${params.endpoint.id} model=${req.model}${refSummary}`
					);
				}
				job = await videoCreate(params.endpoint, req, params.abortSignal);
				if (DEBUG) console.debug(`[video-relay] created job`, job);
				setVideoJobId(params.conversationId, job.id);
			} catch (e) {
				const msg = errorMsg(e);
				console.error(`[video-relay] videoCreate failed:`, msg);
				safeWrite({ type: 'error', message: `Could not start video job: ${msg}` } satisfies StreamErrorEvent);
				try { controller.close(); } catch { /* already closed */ }
				return;
			}

			// Initial state
			emitProgress(safeWrite, job);

			const startedAt = Date.now();
			while (job.status !== 'completed' && job.status !== 'failed') {
				// User clicked Stop — release the bridge slot via DELETE and
				// emit a cancellation error to the client. We don't persist
				// an assistant message for cancelled video jobs.
				if (params.abortSignal?.aborted) {
					if (DEBUG) console.debug(`[video-relay] cancellation observed for job ${job.id}`);
					await videoCancel(params.endpoint, job.id);
					safeWrite({ type: 'error', message: 'Cancelled' } satisfies StreamErrorEvent);
					try { controller.close(); } catch { /* already closed */ }
					return;
				}
				if (Date.now() - startedAt > MAX_WAIT_MS) {
					safeWrite({
						type: 'error',
						message: `Video job ${job.id} did not complete within ${MAX_WAIT_MS / 60_000} minutes`
					} satisfies StreamErrorEvent);
					try { controller.close(); } catch { /* already closed */ }
					return;
				}
				await sleep(POLL_INTERVAL_MS);
				try {
					job = await videoStatus(params.endpoint, job.id);
					if (DEBUG) console.debug(`[video-relay] poll job=${job.id} status=${job.status} progress=${job.progress}`);
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
				try { controller.close(); } catch { /* already closed */ }
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
				const msg = errorMsg(e);
				safeWrite({ type: 'error', message: `Could not fetch video content: ${msg}` } satisfies StreamErrorEvent);
				try { controller.close(); } catch { /* already closed */ }
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
					contentType
				});
				assistantMessage = appendMessage({
					conversationId: params.conversationId,
					parentMessageId: params.userMessage.id,
					role: 'assistant',
					parts: [{ type: 'video', mediaId }],
					modelUsed: params.storedModelId,
					rawResponseJson: JSON.stringify(job)
				});
				linkMessageMedia(assistantMessage.id, mediaId);
			} catch (e) {
				const msg = errorMsg(e);
				safeWrite({ type: 'error', message: `Could not persist video: ${msg}` } satisfies StreamErrorEvent);
				try { controller.close(); } catch { /* already closed */ }
				return;
			}

			const title = await raceTitle(titlePromise, TITLE_DELIVERY_BUDGET_MS);
			if (title) {
				safeWrite({ type: 'title', title } satisfies StreamTitleEvent);
			}

			safeWrite({ type: 'done', assistantMessage } satisfies StreamDoneEvent);
			try { controller.close(); } catch { /* already closed */ }
		}
	});
}

function emitProgress(write: (e: StreamEvent) => void, job: VideoJob): void {
	const ev: StreamProgressEvent = {
		type: 'progress',
		percent: typeof job.progress === 'number' ? job.progress : null,
		status: job.status
	};
	write(ev);
}

function parseUpstreamId(storedModelId: string): string {
	// stored is "{endpoint}::{upstream}"; we want just upstream
	const idx = storedModelId.indexOf('::');
	return idx === -1 ? storedModelId : storedModelId.slice(idx + 2);
}

function errorMsg(e: unknown): string {
	if (e instanceof UpstreamError) return formatUpstreamError(e);
	if (e instanceof Error) return e.message;
	return String(e);
}

function sleep(ms: number): Promise<void> {
	return new Promise((r) => setTimeout(r, ms));
}

function formatSSE(event: StreamEvent): string {
	return `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}
