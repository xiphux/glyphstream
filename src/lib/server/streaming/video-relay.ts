/**
 * Async video generation relay. Sora-shape:
 *   1. POST /v1/videos -> { id, status: "queued" }
 *   2. Poll GET /v1/videos/{id} until status === "completed" | "failed"
 *   3. GET /v1/videos/{id}/content -> mp4 bytes -> persist via MediaStore
 *
 * The full relay lifecycle (slot/queued, start, title, persist as a sibling,
 * regenerate replace-delete, notify, done) lives in the shared `startMediaRelay`
 * scaffold; this module supplies the video-specific `generate` step — the
 * create + poll loop that surfaces `progress` to the client over SSE, then
 * fetches + persists the mp4. Like the chat relay, the recorder runs
 * independently of the client connection: a disconnect mid-poll doesn't abort
 * the job, so the asset still lands.
 */

import { Buffer } from 'node:buffer';
import {
	videoCancel,
	videoCreate,
	videoFetchContent,
	videoStatus,
	type VideoCreateRequest,
	type VideoJob,
} from '../endpoints/client';
import { errorMessage, isAbortError, type SseWriter } from './sse-transport';
import { parseModelId } from '../endpoints/model-id';
import { logLevel } from '../env';
import { persistGeneratedVideo } from '../media/persister';
import { startMediaRelay, type MediaRelayParams } from './media-relay';
import type { StreamErrorEvent, StreamProgressEvent } from '$lib/types/api';

const DEBUG = logLevel() === 'debug';

// Polling cadence: starts tight so the first status flip surfaces fast,
// then backs off by 50% per tick to a 3s ceiling so a 10-minute job
// doesn't burn 400 requests at 1.5s each. 3s is the user-perceived
// ceiling — past that the progress bar starts to feel stuck even when
// the job is still running cleanly.
const MIN_POLL_INTERVAL_MS = 1500;
const MAX_POLL_INTERVAL_MS = 3000;
const MAX_WAIT_MS = 20 * 60_000; // 20 minutes — generous; rate-limited by upstream timeouts anyway

export interface VideoRelayParams extends MediaRelayParams {
	prompt: string;
	/**
	 * Optional I2V reference image — bytes loaded server-side from an
	 * attached media row. The relay forwards them as the `input_reference`
	 * multipart field on POST /v1/videos.
	 */
	inputReference?: { bytes: Buffer; contentType: string };
	/** Media id of the I2V input image (the `inputReference`'s source row), so
	 *  the persisted video records its provenance for the split grid. */
	sourceMediaId?: string | null;
	/**
	 * Fires with the bridge-side job id as soon as POST /v1/videos returns,
	 * so the route can stash it on the in-flight entry for cancellation
	 * (DELETE /v1/videos/{id}). Keeps this relay decoupled from the in-flight
	 * registry's keying — the route owns which entry to update.
	 */
	onJobId?: (jobId: string) => void;
}

export function startVideoRelay(params: VideoRelayParams): ReadableStream<Uint8Array> {
	return startMediaRelay(params, async ({ write, abortSignal }) => {
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
			job = await videoCreate(params.endpoint, req, abortSignal);
			if (DEBUG) console.debug(`[video-relay] created job`, job);
			params.onJobId?.(job.id);
		} catch (e) {
			// A Stop click mid-create aborts the upstream fetch — treat it as a
			// cancellation (matching the in-loop abort path below), not an error.
			if (isAbortError(e) || abortSignal?.aborted) {
				write({ type: 'error', message: 'Cancelled' } satisfies StreamErrorEvent);
				return null;
			}
			const msg = errorMessage(e);
			console.error(`[video-relay] videoCreate failed:`, msg);
			const message = `Could not start video job: ${msg}`;
			write({ type: 'error', message } satisfies StreamErrorEvent);
			return { error: message };
		}

		// Initial state
		emitProgress(write, job);

		const startedAt = Date.now();
		let pollInterval = MIN_POLL_INTERVAL_MS;
		while (job.status !== 'completed' && job.status !== 'failed') {
			// User clicked Stop — release the bridge slot via DELETE and emit a
			// cancellation error. We don't persist an assistant message for
			// cancelled video jobs.
			if (abortSignal?.aborted) {
				if (DEBUG) console.debug(`[video-relay] cancellation observed for job ${job.id}`);
				await videoCancel(params.endpoint, job.id);
				write({ type: 'error', message: 'Cancelled' } satisfies StreamErrorEvent);
				return null;
			}
			if (Date.now() - startedAt > MAX_WAIT_MS) {
				const message = `Video job ${job.id} did not complete within ${MAX_WAIT_MS / 60_000} minutes`;
				write({ type: 'error', message } satisfies StreamErrorEvent);
				return { error: message };
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
			emitProgress(write, job);
		}

		if (job.status === 'failed') {
			const message = job.error?.message ?? 'Video generation failed';
			write({ type: 'error', message } satisfies StreamErrorEvent);
			return { error: message };
		}

		// status === 'completed' — fetch + persist
		let bytes: Buffer;
		let contentType: string;
		try {
			const fetched = await videoFetchContent(params.endpoint, job.id);
			bytes = fetched.bytes;
			contentType = fetched.contentType;
		} catch (e) {
			// A Stop click mid-fetch is a cancellation, not a failure — bail quietly
			// (null) so it leaves no durable error sibling, matching videoCreate.
			if (isAbortError(e) || abortSignal?.aborted) {
				write({ type: 'error', message: 'Cancelled' } satisfies StreamErrorEvent);
				return null;
			}
			const message = `Could not fetch video content: ${errorMessage(e)}`;
			write({ type: 'error', message } satisfies StreamErrorEvent);
			return { error: message };
		}

		let mediaId: string;
		try {
			mediaId = await persistGeneratedVideo({
				userId: params.userId,
				endpoint: params.endpoint,
				sourceModel: params.storedModelId,
				prompt: params.prompt,
				bytes,
				contentType,
				sourceMediaId: params.sourceMediaId ?? null,
			});
		} catch (e) {
			// Same cancellation guard as the fetch step above — a Stop shouldn't
			// leave a spurious "could not persist" error sibling behind.
			if (isAbortError(e) || abortSignal?.aborted) {
				write({ type: 'error', message: 'Cancelled' } satisfies StreamErrorEvent);
				return null;
			}
			const message = `Could not persist video: ${errorMessage(e)}`;
			write({ type: 'error', message } satisfies StreamErrorEvent);
			return { error: message };
		}

		return {
			part: { type: 'video', mediaId },
			mediaId,
			rawResponseJson: JSON.stringify(job),
			modality: 'video',
		};
	});
}

function emitProgress(write: SseWriter['write'], job: VideoJob): void {
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
