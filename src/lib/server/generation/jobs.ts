/**
 * Durable image / video generations.
 *
 * A generation used to exist only inside the HTTP request that submitted it:
 * the relay ran in that request's response stream, its inputs lived in the
 * closure, and its place in the queue was a promise parked on the endpoint
 * gate. The in-flight registry that recovery, the sidebar, Stop and the "N
 * ready" notification all read was just as ephemeral. Restarting GlyphStream —
 * an upgrade, a crash, a host reboot — therefore dropped every queued and
 * running generation without a trace, which on a single-GPU box with a stack of
 * multi-model grids in line is a lot of work to lose.
 *
 * So a generation is now a row (`generation_jobs`) the server owns:
 *
 *  - SUBMIT inserts the row, registers it in flight, starts running it, and
 *    hands back a response stream carrying the same events the relay always
 *    emitted — the client, including an old cached one, can't tell.
 *  - RUN is the unchanged media relay, driven with callbacks that checkpoint
 *    the job as it goes: `running` when the slot is granted, the enhanced
 *    prompt once written, the bridge's video job id once created.
 *  - COMMIT deletes the row in the same transaction that appends the result
 *    (or the durable error sibling). A crash either side of it therefore either
 *    re-runs the job or doesn't — never both, and never neither.
 *  - RESUME, once per process, re-registers every leftover row in submission
 *    order. (That is the order they rejoin in; a job that must first redo
 *    prompt enhancement or load a source image can still be overtaken on the
 *    way to the endpoint gate by one that needn't, as at submit time.) A row still `running` was interrupted mid-generation: it is re-run
 *    once, and failed as a normal error column if it is interrupted again.
 *
 * Because resumed jobs go back into the same in-flight registry, everything
 * that reads it — the recovered grid and bubble, the sidebar dots, Stop, the
 * aggregate notification — works after a restart with no changes of its own.
 * What a resumed job does NOT have is a listener: its events go nowhere until
 * the client's recovery poll picks the result up, as it already does for a
 * generation whose tab was closed.
 */

import { Buffer } from 'node:buffer';
import { generateId } from '../util/id';
import { getEndpoint } from '../endpoints/registry';
import { parseModelId } from '../endpoints/model-id';
import { videoCancel } from '../endpoints/client';
import type { LoadedEndpoint } from '../endpoints/config';
import { getConversationMeta, setConversationAvatar } from '../db/queries/conversations';
import { appendMessage, getMessage } from '../db/queries/messages';
import {
	consumeGenerationJob,
	deleteGenerationJob,
	insertGenerationJob,
	listGenerationJobs,
	markGenerationJobRunning,
	requeueGenerationJob,
	setGenerationJobPrepared,
	setGenerationJobUpstreamId,
	type GenerationJobRow,
} from '../db/queries/generation-jobs';
import { loadMediaBytes, MediaNotAvailableError } from '../media/data-url';
import { notifyFanoutCompleteIfLast } from '../messages/fanout-notify';
import {
	AVATAR_BRANCH,
	clearInFlight,
	DEFAULT_BRANCH,
	registerInFlight,
	type InFlightEntry,
} from '../streaming/in-flight';
import { runImageRelay } from '../streaming/image-relay';
import { runVideoRelay } from '../streaming/video-relay';
import {
	GenerationDiscardedError,
	type MediaRelayParams,
	type MediaRelaySink,
	type PreparedPrompt,
} from '../streaming/media-relay';
import { errorMessage, sseWriter } from '../streaming/sse-transport';
import type { StreamErrorEvent } from '$lib/types/api';

/**
 * What a generation is for. Decides everything the submitting route used to
 * decide with closures, so a resumed job behaves exactly as it would have:
 *
 *  - `send`: an ordinary single-model turn. Advances the leaf, runs the
 *    first-exchange title task, notifies on its own.
 *  - `fanout`: one branch of a multi-model grid. A pinned sibling; the grid's
 *    single "N ready" notification fires when the last branch settles.
 *  - `avatar`: a background portrait draw. Advances the leaf only if the user
 *    hasn't moved on, and applies the portrait as the conversation's avatar.
 *  - `avatar_fanout`: one portrait of an avatar comparison — a pinned sibling
 *    like `fanout`; the pick applies the winner, not the relay.
 */
export type JobOrigin = GenerationJobRow['origin'];

/**
 * The inputs a job needs beyond its row's own columns. Resolved once, at
 * submit, and stored — so a job resumed after a restart runs with what the
 * user asked for then, not with whatever the model catalogue says now.
 *
 * A PERSISTED format that crosses versions: a job queued before an upgrade is
 * resumed by the new release. Add fields as optional; don't rename or repurpose
 * one without handling rows the previous release wrote.
 */
export interface GenerationJobParams {
	prompt: string;
	/** Input images for an edit / animation, by media id. */
	dispatchMediaIds: string[];
	/** Split-attachments provenance — see `MediaRelayParams.sourceMediaId`. */
	sourceMediaId: string | null;
	aspectRatio?: string;
	enhancementEnabled: boolean;
	promptStyle: string | null;
	promptHint: string | null;
	/** Persist as display-only (avatar portraits) — see the image relay. */
	displayOnly?: boolean;
	/** The client's dispatched grid size, for the aggregate notification. */
	fanoutSize?: number;
}

export interface SubmitGenerationJob {
	userId: string;
	conversationId: string;
	anchorMessageId: string;
	kind: 'image' | 'video';
	origin: JobOrigin;
	modelId: string;
	fanoutIndex: number | null;
	params: GenerationJobParams;
}

/** How many times a job may be interrupted by a restart and still be re-run.
 *  One: a generation that dies twice is more likely the cause than a victim. */
const MAX_INTERRUPTIONS = 1;

/**
 * Before this, the leftover queue is re-registered from the first signed-in
 * request, whichever comes first. Matches the media purger's first sweep: late
 * enough that nothing opens the database at boot (see `adminBootstrapChecked`
 * in hooks.server.ts), early enough that an idle server picks its queue back up
 * without waiting for someone to open the app.
 */
const RESUME_DELAY_MS = 10_000;

const isFanoutOrigin = (o: JobOrigin) => o === 'fanout' || o === 'avatar_fanout';

/** A sink with no listener — a resumed job's events go nowhere. */
const NO_LISTENER: MediaRelaySink = { write: () => {}, close: () => {} };

/**
 * Queue a generation and start running it. Returns the response stream the
 * submitting request serves: the same event sequence the relay has always
 * emitted, so nothing downstream of the route changes.
 *
 * The caller is responsible for any admission checks (the fan-out cap, a
 * parked comparison) — they must run synchronously right before this, because
 * this is where the job registers in flight, and it does so before returning.
 */
export function submitGenerationJob(input: SubmitGenerationJob): ReadableStream<Uint8Array> {
	// Resume BEFORE queueing anything new, so the leftover queue re-registers
	// ahead of work submitted after the restart (modulo the async pre-slot steps
	// noted in the header). A no-op once it has run.
	resumeGenerationJobs();

	const row: GenerationJobRow = {
		id: generateId(),
		userId: input.userId,
		conversationId: input.conversationId,
		anchorMessageId: input.anchorMessageId,
		kind: input.kind,
		origin: input.origin,
		modelId: input.modelId,
		fanoutIndex: input.fanoutIndex,
		state: 'queued',
		attempts: 0,
		paramsJson: JSON.stringify(input.params),
		preparedJson: null,
		upstreamJobId: null,
		createdAt: Date.now(),
		startedAt: null,
	};
	// The route resolved this endpoint moments ago; its absence here would be a
	// caller bug, not a state to recover from.
	const endpoint = endpointFor(row);
	if (!endpoint) throw new Error(`No endpoint for model "${row.modelId}"`);
	insertGenerationJob(row);
	const entry = register(row, endpoint);
	return new ReadableStream({
		start(controller) {
			return runJob(row, entry, sseWriter(controller));
		},
	});
}

/**
 * Whether this PROCESS has taken its leftover queue back — kept on `globalThis`
 * rather than in a module variable because it describes the process, not this
 * module instance. Under `pnpm dev` an edit re-evaluates this module; a fresh
 * `false` would then have the next resume read the rows of generations still
 * running in the old instance as leftovers, re-register them (aborting the
 * live ones, which share their registry keys) and run them again.
 */
const RESUMED = Symbol.for('glyphstream.generationJobs.resumed');
const processState = globalThis as typeof globalThis & { [RESUMED]?: boolean };

let resumeTimer: ReturnType<typeof setTimeout> | null = null;
/** Set by the shutdown hook: a draining process arms no new fallback timer. */
let shuttingDown = false;

/**
 * Re-register every job left over from a previous process. Idempotent: the
 * first call does the work, every later one returns immediately. Never throws —
 * a failure here must not take down the request that happened to trigger it.
 */
export function resumeGenerationJobs(): void {
	if (processState[RESUMED]) return;
	if (resumeTimer) clearTimeout(resumeTimer);
	resumeTimer = null;

	let rows: GenerationJobRow[];
	try {
		rows = listGenerationJobs();
	} catch (e) {
		// NOT marked resumed: the queue is still in the table and this process
		// hasn't taken it back. A transient failure (a busy database at boot) must
		// not strand it until the next restart — the fallback timer retries, as
		// does the next submit.
		console.error('[generation-jobs] could not read the queue to resume it:', errorMessage(e));
		scheduleGenerationJobResume();
		return;
	}
	// Set once the read succeeded, and before anything below can re-enter.
	processState[RESUMED] = true;
	if (rows.length > 0) console.log(`[generation-jobs] resuming ${rows.length} generation(s)`);

	// Failed AFTER everything resumable is registered: a grid branch failing here
	// asks "am I the last of my grid?" of the registry, and must not find it empty
	// only because its siblings haven't been re-registered yet.
	const failures: Array<{ row: GenerationJobRow; message: string }> = [];
	for (const found of rows) {
		let row = found;
		try {
			const endpoint = endpointFor(row);
			if (!endpoint) {
				failures.push({ row, message: `Model "${row.modelId}" is no longer configured` });
				continue;
			}
			if (row.state === 'running') {
				// It was generating when the process died. Whatever the upstream was
				// doing for it is orphaned — nobody will ever collect it — so let go of
				// a bridge video job rather than leave it holding the GPU.
				if (row.kind === 'video' && row.upstreamJobId) {
					void videoCancel(endpoint, row.upstreamJobId).catch(() => {});
				}
				const attempts = row.attempts + 1;
				if (attempts > MAX_INTERRUPTIONS) {
					failures.push({ row, message: 'Generation was interrupted by a server restart' });
					continue;
				}
				requeueGenerationJob(row.id, attempts);
				row = { ...row, state: 'queued', attempts, startedAt: null, upstreamJobId: null };
			}
			const entry = register(row, endpoint);
			// The queue wait counts from when the user asked, not from the restart.
			entry.startedAt = row.createdAt;
			// `runJob` is built not to reject, but nothing awaits this run: a
			// rejection that slipped through would be unhandled, which is fatal.
			runJob(row, entry, NO_LISTENER).catch((e: unknown) =>
				console.error(`[generation-jobs] resumed job ${row.id} failed:`, errorMessage(e)),
			);
		} catch (e) {
			console.error(`[generation-jobs] could not resume job ${row.id}:`, errorMessage(e));
		}
	}
	for (const { row, message } of failures) {
		try {
			failAtResume(row, message);
		} catch (e) {
			console.error(`[generation-jobs] could not fail job ${row.id}:`, errorMessage(e));
		}
	}
}

/** Arm the fallback resume for a server nobody visits. Called once at boot. */
export function scheduleGenerationJobResume(): void {
	if (processState[RESUMED] || resumeTimer || shuttingDown) return;
	resumeTimer = setTimeout(resumeGenerationJobs, RESUME_DELAY_MS);
	// Must not hold a shutting-down process open on its own.
	resumeTimer.unref?.();
}

/** Disarm the fallback resume for good — the shutdown hook. A failed read
 *  during the drain won't re-arm it. Queued rows stay put. */
export function stopGenerationJobResume(): void {
	shuttingDown = true;
	if (resumeTimer) clearTimeout(resumeTimer);
	resumeTimer = null;
}

/** Test-only: forget that this process has resumed. */
export function resetGenerationJobsForTests(): void {
	stopGenerationJobResume();
	shuttingDown = false;
	processState[RESUMED] = false;
}

function register(row: GenerationJobRow, endpoint: LoadedEndpoint): InFlightEntry {
	return registerInFlight(
		row.conversationId,
		endpoint,
		// A single send takes the conversation's default slot and an avatar draw
		// its own — both supersede their predecessor, as they always have. Grid
		// branches coexist, so each is keyed by its job.
		row.origin === 'send' ? DEFAULT_BRANCH : row.origin === 'avatar' ? AVATAR_BRANCH : row.id,
		row.kind,
		row.modelId,
		parseParams(row).sourceMediaId,
		// A background portrait isn't part of the conversation's turn: recovery,
		// the grid and the aggregate notification must not count it.
		row.origin !== 'avatar',
	);
}

function endpointFor(row: GenerationJobRow): LoadedEndpoint | undefined {
	const parsed = parseModelId(row.modelId);
	return parsed ? getEndpoint(parsed.endpointId) : undefined;
}

function parseParams(row: GenerationJobRow): GenerationJobParams {
	return JSON.parse(row.paramsJson) as GenerationJobParams;
}

/**
 * Run one job to completion. Never rejects: every outcome — success, failure,
 * Stop, a vanished anchor — ends with the row gone and the registry cleared.
 */
async function runJob(
	row: GenerationJobRow,
	entry: InFlightEntry,
	sink: MediaRelaySink,
): Promise<void> {
	let settled = false;
	const params = parseParams(row);
	// Clears the registry and, for a grid branch, lets the last one to settle fire
	// the aggregate "N ready". Idempotent, because the relay calls it from its own
	// `finally` and this function calls it again from its own.
	//
	// Guarded: it runs from `finally` blocks, and the notification reads the DB.
	// A throw there would reject a run nobody awaits (a resumed job's), which
	// Node treats as fatal — a lost notification is not worth the process.
	const settle = () => {
		if (settled) return;
		settled = true;
		try {
			clearInFlight(row.conversationId, entry);
			if (isFanoutOrigin(row.origin)) {
				notifyFanoutCompleteIfLast({
					conversationId: row.conversationId,
					userId: row.userId,
					userMessageId: row.anchorMessageId,
					conversationTitle: getConversationMeta(row.conversationId, row.userId)?.title ?? null,
					modality: row.kind,
					fanoutSize: params.fanoutSize,
				});
			}
		} catch (e) {
			console.error(`[generation-jobs] could not settle job ${row.id}:`, errorMessage(e));
		}
	};

	try {
		const meta = getConversationMeta(row.conversationId, row.userId);
		const anchor = meta ? getMessage(row.conversationId, row.anchorMessageId) : null;
		// Its conversation or anchor is gone. The FK cascade normally takes the row
		// with it; this is the window where the delete landed after the read.
		if (!meta || !anchor) {
			sink.write({ type: 'error', message: 'Cancelled' } satisfies StreamErrorEvent);
			sink.close();
			return;
		}
		const endpoint = endpointFor(row);
		const parsed = parseModelId(row.modelId);
		if (!endpoint || !parsed) {
			failBeforeRun(row, params, `Model "${row.modelId}" is no longer configured`, sink);
			return;
		}

		const common: MediaRelayParams = {
			conversationId: row.conversationId,
			userId: row.userId,
			conversationTitle: meta.title,
			endpoint,
			storedModelId: row.modelId,
			userMessage: anchor,
			sourceMediaId: params.sourceMediaId,
			abortSignal: entry.controller.signal,
			advanceActiveLeaf: !isFanoutOrigin(row.origin),
			fanoutIndex: row.fanoutIndex,
			// An avatar draw anchors on a reply that already existed and can take
			// minutes, so it only advances the leaf if the user hasn't moved on.
			advanceActiveLeafIfCurrent: row.origin === 'avatar' ? row.anchorMessageId : undefined,
			// A grid runs the title task once, from /prepare; an avatar draw is a
			// side errand in a conversation that already has a title.
			suppressTitleTask: row.origin !== 'send',
			// A grid fires one aggregate notification instead of one per branch.
			suppressNotify: isFanoutOrigin(row.origin),
			inFlight: entry,
			preparedPrompt: row.preparedJson
				? (JSON.parse(row.preparedJson) as PreparedPrompt)
				: undefined,
			onPromptPrepared: (prepared) => setGenerationJobPrepared(row.id, JSON.stringify(prepared)),
			onGenerationStarted: () => {
				// The row is gone: its branch or conversation was deleted while it
				// waited in line. Don't spend the GPU on a result with nowhere to go.
				if (!markGenerationJobRunning(row.id, Date.now())) entry.controller.abort();
			},
			persistWith: (tx) => {
				if (!consumeGenerationJob(tx, row.id)) throw new GenerationDiscardedError();
			},
			onMediaPersisted:
				row.origin === 'avatar'
					? (mediaId) => {
							const result = setConversationAvatar(row.conversationId, row.userId, mediaId);
							// Both reasons are races (the conversation deleted, or the media
							// reaped, between persist and now) — worth a log line, not a
							// failure of a generation that otherwise worked.
							if (!result.ok) {
								console.warn(
									`[avatar] could not apply portrait to ${row.conversationId}: ${result.reason}`,
								);
							}
						}
					: undefined,
			onGenerationSettled: () => clearInFlight(row.conversationId, entry),
			onComplete: settle,
		};

		if (row.kind === 'image') {
			await runImageRelay(
				{
					...common,
					upstreamModelId: parsed.upstreamId,
					prompt: params.prompt,
					dispatchMediaIds: params.dispatchMediaIds,
					sourceMediaId: params.sourceMediaId,
					promptStyle: params.promptStyle,
					promptHint: params.promptHint,
					enhancementEnabled: params.enhancementEnabled,
					aspectRatio: params.aspectRatio,
					displayOnly: params.displayOnly,
				},
				sink,
			);
			return;
		}

		// I2V: the reference frame is loaded here, at run time, rather than by the
		// route — a resumed job has no route. Only one reference is honored: the
		// /v1/videos spec is single-reference.
		let inputReference: { bytes: Buffer; contentType: string } | undefined;
		if (params.dispatchMediaIds.length > 0) {
			try {
				const loaded = await loadMediaBytes(params.dispatchMediaIds[0], row.userId);
				inputReference = { bytes: loaded.bytes, contentType: loaded.contentType };
			} catch (e) {
				if (!(e instanceof MediaNotAvailableError)) throw e;
				failBeforeRun(row, params, 'The source image was deleted and is no longer available', sink);
				return;
			}
		}
		await runVideoRelay(
			{
				...common,
				prompt: params.prompt,
				inputReference,
				promptStyle: params.promptStyle,
				promptHint: params.promptHint,
				enhancementEnabled: params.enhancementEnabled,
				aspectRatio: params.aspectRatio,
				// Recorded so Stop can DELETE the bridge job, and so a restart can let
				// go of it (see resume).
				onJobId: (jobId) => {
					entry.videoJobId = jobId;
					setGenerationJobUpstreamId(row.id, jobId);
				},
			},
			sink,
		);
	} catch (e) {
		// The relay turns every generation failure into an event; reaching here
		// means something outside it broke (a DB error, a malformed row).
		console.error(`[generation-jobs] job ${row.id} failed:`, errorMessage(e));
		sink.write({ type: 'error', message: errorMessage(e) } satisfies StreamErrorEvent);
		sink.close();
	} finally {
		// Every exit that didn't commit an outcome — Stop, a discarded result, a
		// crash out of the relay — still owes the row its deletion. A no-op after a
		// commit, which already consumed it.
		try {
			deleteGenerationJob(row.id);
		} catch (e) {
			console.error(`[generation-jobs] could not delete job ${row.id}:`, errorMessage(e));
		}
		settle();
	}
}

/** Fail a job before the relay ran: a durable error column, like any failure. */
function failBeforeRun(
	row: GenerationJobRow,
	params: GenerationJobParams,
	message: string,
	sink: MediaRelaySink,
): void {
	const messageId = persistFailure(row, params, message);
	sink.write({ type: 'error', message, messageId } satisfies StreamErrorEvent);
	sink.close();
}

/** A leftover job that can't be resumed — failed as an error column instead. */
function failAtResume(row: GenerationJobRow, message: string): void {
	persistFailure(row, parseParams(row), message);
	// A grid branch failing here may be the last of its grid.
	if (isFanoutOrigin(row.origin)) {
		notifyFanoutCompleteIfLast({
			conversationId: row.conversationId,
			userId: row.userId,
			userMessageId: row.anchorMessageId,
			conversationTitle: getConversationMeta(row.conversationId, row.userId)?.title ?? null,
			modality: row.kind,
			fanoutSize: parseParams(row).fanoutSize,
		});
	}
}

/**
 * Append the durable error sibling for a job that failed outside the relay,
 * consuming the job in the same transaction. Returns the row's id, or undefined
 * when the job was already gone (its anchor deleted) and nothing was written.
 */
function persistFailure(
	row: GenerationJobRow,
	params: GenerationJobParams,
	message: string,
): string | undefined {
	try {
		return appendMessage({
			conversationId: row.conversationId,
			parentMessageId: row.anchorMessageId,
			role: 'assistant',
			parts: [{ type: 'error', message, sourceMediaId: params.sourceMediaId }],
			modelUsed: row.modelId,
			advanceActiveLeaf: !isFanoutOrigin(row.origin),
			advanceActiveLeafIfCurrent: row.origin === 'avatar' ? row.anchorMessageId : undefined,
			fanoutIndex: row.fanoutIndex,
			inTransaction: (tx) => {
				if (!consumeGenerationJob(tx, row.id)) throw new GenerationDiscardedError();
			},
		}).id;
	} catch (e) {
		if (!(e instanceof GenerationDiscardedError)) {
			console.warn(`[generation-jobs] could not persist failure for ${row.id}:`, errorMessage(e));
		}
		deleteGenerationJob(row.id);
		return undefined;
	}
}
