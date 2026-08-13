/**
 * Async video generation relay. Sora-shape:
 *   1. POST /v1/videos -> { id, status: "queued" }
 *   2. Poll GET /v1/videos/{id} until status === "completed" | "failed"
 *   3. GET /v1/videos/{id}/content -> mp4 bytes -> persist via MediaStore
 *
 * The full relay lifecycle (slot/queued, start, title, persist as a sibling,
 * notify, done) lives in the shared `startMediaRelay`
 * scaffold; this module supplies the video-specific `generate` step — the
 * create + poll loop that surfaces `progress` to the client over SSE, then
 * fetches + persists the mp4. Like the chat relay, the recorder runs
 * independently of the client connection: a disconnect mid-poll doesn't abort
 * the job, so the asset still lands.
 */

import { Buffer } from 'node:buffer';
import { Readable } from 'node:stream';
import {
	isPermanentRequestError,
	videoCancel,
	videoCreate,
	videoFetchContent,
	videoStatus,
	type VideoCreateRequest,
	type VideoJob,
	type VideoStatus,
} from '../endpoints/client';
import { errorMessage, isAbortError, type SseWriter } from './sse-transport';
import { parseModelId } from '../endpoints/model-id';
import { logLevel } from '../env';
import { persistGeneratedVideo } from '../media/persister';
import { runPromptEnhancement } from './media-enhance';
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
	/**
	 * Fires with the bridge-side job id as soon as POST /v1/videos returns,
	 * so the route can stash it on the in-flight entry for cancellation
	 * (DELETE /v1/videos/{id}). Keeps this relay decoupled from the in-flight
	 * registry's keying — the route owns which entry to update.
	 */
	onJobId?: (jobId: string) => void;
	/** Target model's preferred prompt style (canonical video-style key) or null
	 *  when unknown — null runs the enhancer's format-preserving clarify-only pass. */
	promptStyle?: string | null;
	/** Per-model freeform enhancer hint, or null. */
	promptHint?: string | null;
	/** Whether video-prompt enhancement is enabled for this send (the feature
	 *  category is not in the conversation's disabledFeatures). */
	enhancementEnabled?: boolean;
}

export function startVideoRelay(params: VideoRelayParams): ReadableStream<Uint8Array> {
	// `effectivePrompt` is what actually generates the video (the enhanced prompt
	// when enhancement changed it, else the verbatim prompt); `originalPrompt`
	// preserves the user's text only when it changed. Both are populated by the
	// prepare step below and read by the generate step. Mirrors image-relay.
	let effectivePrompt = params.prompt;
	let originalPrompt: string | null = null;

	// Prompt enhancement runs as the relay's PRE-SLOT prepare step (shared with
	// the image relay — see `media-enhance.ts`). Text-to-video only: an i2v
	// prompt rides alongside a reference frame, so leave it verbatim for v1.
	const prepare = async (ctx: {
		write: (e: StreamProgressEvent) => void;
		abortSignal?: AbortSignal;
	}) => {
		const r = await runPromptEnhancement(
			{
				prompt: params.prompt,
				medium: 'video',
				isTextToMedia: !params.inputReference,
				enabled: params.enhancementEnabled,
				promptStyle: params.promptStyle,
				promptHint: params.promptHint,
			},
			ctx,
		);
		effectivePrompt = r.effectivePrompt;
		originalPrompt = r.originalPrompt;
	};

	return startMediaRelay({ ...params, prepare }, async ({ write, abortSignal }) => {
		let job: VideoJob;
		try {
			const req: VideoCreateRequest = {
				model: parseModelId(params.storedModelId)?.upstreamId ?? params.storedModelId,
				prompt: effectivePrompt,
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
			// No `error` frame here — the scaffold emits it after persisting the
			// durable error sibling, so it can carry that row's id (see MediaFailure).
			const message = `Could not start video job: ${msg}`;
			return { error: message };
		}

		// Distinct out-of-spec statuses already logged for this job, so a 20-minute
		// poll loop warns once rather than on every tick.
		const warnedStatuses = new Set<string>();

		// Initial state
		emitProgress(write, job, warnedStatuses);

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
				// Best-effort cancel of the bridge job, mirroring the abort path above
				await videoCancel(params.endpoint, job.id);
				const message = `Video job ${job.id} did not complete within ${MAX_WAIT_MS / 60_000} minutes`;
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
				// A permanent, request-specific failure (e.g. the bridge restarted
				// and lost the job → 404) will recur identically on every future
				// poll — bail now instead of re-polling to MAX_WAIT_MS while holding
				// the endpoint concurrency slot for 20 minutes on a dead job.
				if (isPermanentRequestError(e)) {
					await videoCancel(params.endpoint, job.id).catch(() => {});
					const message = `Video job ${job.id} failed: ${errorMessage(e)}`;
					return { error: message };
				}
				// Transient upstream blip — keep polling unless we've burned the budget.
				console.warn(`[video-relay] poll error for job ${job.id}:`, e);
				continue;
			}
			emitProgress(write, job, warnedStatuses);
		}

		if (job.status === 'failed') {
			const message = job.error?.message ?? 'Video generation failed';
			return { error: message };
		}

		// status === 'completed' — fetch + persist
		let stream: Readable;
		let contentType: string;
		try {
			const fetched = await videoFetchContent(params.endpoint, job.id);
			stream = fetched.stream;
			contentType = fetched.contentType;
		} catch (e) {
			// A Stop click mid-fetch is a cancellation, not a failure — bail quietly
			// (null) so it leaves no durable error sibling, matching videoCreate.
			if (isAbortError(e) || abortSignal?.aborted) {
				write({ type: 'error', message: 'Cancelled' } satisfies StreamErrorEvent);
				return null;
			}
			const message = `Could not fetch video content: ${errorMessage(e)}`;
			return { error: message };
		}

		let mediaId: string;
		try {
			mediaId = await persistGeneratedVideo({
				userId: params.userId,
				endpoint: params.endpoint,
				sourceModel: params.storedModelId,
				prompt: effectivePrompt,
				originalPrompt,
				stream,
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

// A progress event's `status` is display text, not a machine value — the
// fan-out grid renders it verbatim in place of "Generating…". So map the
// provider's job enum rather than forwarding it. Both collections are BUILT
// keyed by `VideoStatus` (so a typo'd entry fails to compile) but EXPOSED keyed
// by string, because what arrives at runtime may be neither — see `phaseLabel`.
const PHASE_LABELS: ReadonlyMap<string, string> = new Map<VideoStatus, string>([
	['queued', 'Queued upstream…'],
]);

// The spec statuses that need no label of their own: `in_progress` is the
// ordinary case both views already narrate ("Generating video" / "Generating…"),
// and the terminal pair is announced by the `done` / `error` events that follow.
// Anything NOT listed here and not in PHASE_LABELS is out of spec.
const SILENT_STATUSES: ReadonlySet<string> = new Set<VideoStatus>([
	'in_progress',
	'completed',
	'failed',
]);

// Longest out-of-spec status we'll put on screen. Svelte escapes it, but an
// unbounded string would still wreck the badge layout.
const MAX_RAW_STATUS_CHARS = 32;

/** Display text for a job status, or undefined when there's no sub-phase worth
 *  naming. An unrecognized status is surfaced raw rather than swallowed: the
 *  poll loop only exits on `completed`/`failed`, so a bridge reporting some
 *  fourth state would otherwise spin to MAX_WAIT_MS behind a bare ticking timer
 *  with nothing to suggest it's stuck rather than generating. */
function phaseLabel(status: VideoStatus, warned: Set<string>): string | undefined {
	// `VideoStatus` is a compile-time assumption only — the poll response is cast
	// by `parseJson`, never validated — so treat the value as untrusted provider
	// input from here down. A missing or non-string status is nothing the user
	// could act on anyway, and coercing it would put a literal "undefined" on
	// screen: precisely the leak this mapping exists to prevent.
	const raw: string = status;
	if (typeof raw !== 'string' || raw === '') return undefined;

	const label = PHASE_LABELS.get(raw);
	if (label) return label;
	if (SILENT_STATUSES.has(raw)) return undefined;

	// Truncate before both the log and the label, so an absurd upstream string
	// can't bloat the server log either.
	const shown = raw.slice(0, MAX_RAW_STATUS_CHARS);
	// Poll ticks every 1.5–3s, so warn once per distinct status per job.
	if (!warned.has(shown)) {
		warned.add(shown);
		console.warn(`[video-relay] unrecognized job status ${JSON.stringify(shown)}`);
	}
	return shown;
}

function emitProgress(write: SseWriter['write'], job: VideoJob, warned: Set<string>): void {
	const label = phaseLabel(job.status, warned);
	const ev: StreamProgressEvent = {
		type: 'progress',
		percent: typeof job.progress === 'number' ? job.progress : null,
		...(label ? { status: label } : {}),
	};
	write(ev);
}

function sleep(ms: number): Promise<void> {
	return new Promise((r) => setTimeout(r, ms));
}
