/**
 * The scheduled-task runner: fires each schedule's slots and drives its runs.
 *
 * A run is an ordinary chat turn in a fresh conversation, started with nobody
 * connected — through the same `startChatTurn` a send uses, so history,
 * branching, the gallery and the approval flow all work on it unchanged. What
 * makes it a scheduled run:
 *
 *  - its endpoint slot is `background` priority, so it waits behind anyone
 *    actually waiting on a reply (and never interrupts one), bounded by the
 *    schedule's deadline — a run still queued at the deadline fails (as
 *    `deadline`, which counts toward the auto-disable streak);
 *  - its tools are the schedule's policy, not the conversation's defaults, and
 *    the MCP servers that policy relies on are checked before it starts;
 *  - it notifies on every ending — finished, waiting for approval, failed —
 *    because nobody was watching it happen.
 *
 * The slot bookkeeping is in the database (`scheduled_runs`, unique per slot),
 * so a tick that races itself can't fire a slot twice; the turn itself is not
 * durable, so a restart mid-run fails that run as `interrupted` rather than
 * retrying it (Run now is the retry).
 */
import type {
	ChatMessage,
	ScheduledRunFailureKind,
	ScheduledTask,
	ScheduledToolPolicy,
} from '#lib/types/api.js';
import {
	createConversation,
	deleteConversation,
	getConversationMeta,
} from '../db/queries/conversations';
import { getMessage } from '../db/queries/messages';
import {
	conversationsBeyondRetention,
	expireWaitingScheduledRuns,
	getScheduledRunForConversation,
	getScheduledTask,
	insertScheduledRun,
	listDueScheduledTasks,
	listUnsettledScheduledRuns,
	recordScheduledTaskResult,
	setScheduledTaskNextRun,
	updateScheduledRun,
} from '../db/queries/scheduled-tasks';
import { getScheduledTasksConfig } from '../endpoints/config';
import { parseModelId } from '../endpoints/model-id';
import { getEndpoint } from '../endpoints/registry';
import { createUserMessage } from '../messages/create-user-message';
import { buildPreview, notifyConversationComplete } from '../push/notify';
import { appendErrorSibling } from '../streaming/error-sibling';
import { clearInFlight, registerInFlight } from '../streaming/in-flight';
import type { TurnOutcome } from '../streaming/relay';
import { startChatTurn } from '../chat/start-turn';
import { createLogger } from '../log';
import { createSweeper } from '../util/sweeper';
import { errorMessage } from '../streaming/sse-transport';
import { processBootedAt } from './boot';
import { jitterFor, nextSlotAfter } from './cadence';
import { preflightMcp } from './preflight';

const log = createLogger('scheduled');

const TICK_MS = 60_000;
const INITIAL_DELAY_MS = 20_000;
/** Schedules fired per tick. Each one only starts a run (the turn queues on
 *  the gate), so this bounds the tick's own work, not GPU load. */
const MAX_FIRES_PER_TICK = 50;
/** Bound on walking a cadence forward past missed slots — an hourly schedule
 *  offline for a year is ~8,800 steps. */
const MAX_CATCHUP_STEPS = 20_000;
/** How long a run may wait on an approval before it's closed out as expired.
 *  Waiting holds nothing (no slot, no in-flight entry), so this is about the
 *  run history saying something true, and letting retention reach the run. */
export const NEEDS_INPUT_EXPIRY_MS = 7 * 24 * 3_600_000;

type DueTask = ScheduledTask & { userId: string };

let running = false;

/**
 * One tick: every enabled schedule whose slot (plus its jitter) has come is
 * advanced to its next slot and, unless the moment has passed, run. Returns how
 * many runs it started. Safe to call directly (tests do); re-entrant calls
 * return 0.
 *
 * Missed slots — the server was down across several — are not replayed: only
 * the latest is considered, the earlier ones recorded once as `missed`. And the
 * latest only runs if its deadline hasn't passed; a 07:00 brief isn't wanted
 * when the server comes back at noon.
 */
export async function runScheduledTaskSweep(now = Date.now()): Promise<number> {
	if (running) return 0;
	running = true;
	try {
		expireWaitingScheduledRuns(now - NEEDS_INPUT_EXPIRY_MS, now);
		let started = 0;
		for (const task of listDueScheduledTasks(now, MAX_FIRES_PER_TICK)) {
			const slot = task.nextRunAt!;
			if (slot + jitterFor(task.id) > now) continue;
			const { latest, missed } = latestSlotBy(task, slot, now);
			// Advance BEFORE running, so a crash mid-fire can't leave the schedule
			// pointing at a slot it already fired (the unique index backs this up).
			setScheduledTaskNextRun(task.id, nextSlotAfter(task.cadence, task.timezone, latest));
			if (missed > 0) {
				insertScheduledRun({
					scheduleId: task.id,
					userId: task.userId,
					slotAt: slot,
					trigger: 'schedule',
					state: 'skipped',
					failureKind: 'missed',
					failureDetail:
						missed === 1
							? 'Missed while the server was down'
							: `${missed} runs missed while the server was down`,
					now,
				});
			}
			if (now > latest + task.deadlineMinutes * 60_000) {
				insertScheduledRun({
					scheduleId: task.id,
					userId: task.userId,
					slotAt: latest,
					trigger: 'schedule',
					state: 'skipped',
					failureKind: 'missed',
					failureDetail: 'The server was down until past the deadline',
					now,
				});
				continue;
			}
			if (startScheduledRun(task, latest, 'schedule')) started++;
		}
		return started;
	} finally {
		running = false;
	}
}

/** The last slot at or before `now`, walking forward from the due `slot`, and
 *  how many slots before it were passed over. */
function latestSlotBy(
	task: DueTask,
	slot: number,
	now: number,
): { latest: number; missed: number } {
	let latest = slot;
	let missed = 0;
	for (let i = 0; i < MAX_CATCHUP_STEPS; i++) {
		const next = nextSlotAfter(task.cadence, task.timezone, latest);
		if (next === null || next > now) break;
		latest = next;
		missed++;
	}
	return { latest, missed };
}

/**
 * File a run for `slotAt` and start it in the background. Returns the run id,
 * or null when that slot already has a run (a racing tick, or Run now pressed
 * twice in the same millisecond). Run now calls this directly with the moment
 * it was pressed; it ignores the cadence but still queues like any run.
 */
export function startScheduledRun(
	task: DueTask,
	slotAt: number,
	trigger: 'schedule' | 'manual',
): string | null {
	const run = insertScheduledRun({
		scheduleId: task.id,
		userId: task.userId,
		slotAt,
		trigger,
		state: 'queued',
	});
	if (!run) return null;
	const progress: RunProgress = { conversationId: null, userMessageId: null, settled: false };
	void executeRun(task, run.id, slotAt, progress).catch((e: unknown) => {
		// Settling itself threw (its bookkeeping, retention, the notification):
		// the run already ended, and a second ending would bury its reply under
		// an error and count it twice.
		if (progress.settled) {
			log.warn(`run ${run.id} of schedule ${task.id} failed while settling:`, e);
			return;
		}
		log.warn(`run ${run.id} of schedule ${task.id} failed to start:`, e);
		const detail = errorMessage(e);
		// Say so in the conversation, if it got that far: that's what the
		// notification opens, and a bare prompt with no reply explains nothing.
		if (progress.conversationId && progress.userMessageId) {
			failInConversation(progress.conversationId, progress.userMessageId, task.modelId, detail);
		}
		settleRun(task, run.id, progress.conversationId, {
			kind: 'failed',
			failureKind: 'internal',
			detail,
		});
	});
	return run.id;
}

/** How far `executeRun` got, for a failure it throws to report against. */
type RunProgress = {
	conversationId: string | null;
	userMessageId: string | null;
	/** Set as `executeRun` settles the run — from then on, it has ended. */
	settled: boolean;
};

/** How a run ended, from the runner's side. */
type RunEnding =
	| { kind: 'done'; assistantMessageId: string }
	| { kind: 'needs_input'; assistantMessageId: string; toolNames: string[] }
	| { kind: 'failed'; failureKind: ScheduledRunFailureKind; detail: string }
	| { kind: 'stopped' };

async function executeRun(
	task: DueTask,
	runId: string,
	slotAt: number,
	progress: RunProgress,
): Promise<void> {
	const settle = (
		conversationId: string | null,
		ending: RunEnding,
		startedAt: number | null = null,
	) => {
		progress.settled = true;
		settleRun(task, runId, conversationId, ending, startedAt);
	};
	const parsed = parseModelId(task.modelId);
	const unavailable = `The model "${task.modelId}" is no longer configured`;
	if (!parsed) {
		// Validated at save, so not reachable short of a hand-edited row; with no
		// endpoint to file a conversation under, the run history is all there is.
		settle(null, {
			kind: 'failed',
			failureKind: 'model_unavailable',
			detail: unavailable,
		});
		return;
	}
	const endpoint = getEndpoint(parsed.endpointId);

	const title = runTitle(task, slotAt);
	const conversation = createConversation({
		userId: task.userId,
		endpointId: parsed.endpointId,
		modelId: task.modelId,
		modelKind: 'chat',
		customModelId: task.customModelId,
		systemPrompt: task.systemPrompt,
		parameters: task.parameters,
		disabledFeatures: task.disabledFeatures,
		title,
		// The schedule named it; the title task has nothing to add.
		titleSource: 'user',
		scheduleId: task.id,
	});
	progress.conversationId = conversation.id;
	updateScheduledRun(runId, { conversationId: conversation.id, state: 'running' });
	const userMessage = createUserMessage({
		conversationId: conversation.id,
		userId: task.userId,
		text: task.prompt,
		attachedMediaIds: [],
		activeLeafMessageId: null,
		existingTitle: title,
		dispatchedModels: [{ modelId: task.modelId, count: 1 }],
	});
	progress.userMessageId = userMessage.id;

	// A removed model still gets its conversation, so the failure has somewhere
	// to be shown and a notification to open — a schedule failing daily in
	// silence would only ever be noticed in Settings.
	if (!endpoint) {
		failInConversation(conversation.id, userMessage.id, task.modelId, unavailable);
		settle(conversation.id, {
			kind: 'failed',
			failureKind: 'model_unavailable',
			detail: unavailable,
		});
		return;
	}

	const preflight = await preflightMcp(task.userId, task.toolPolicy, task.disabledFeatures);
	if (!preflight.ok) {
		failInConversation(conversation.id, userMessage.id, task.modelId, preflight.detail);
		settle(conversation.id, {
			kind: 'failed',
			failureKind: preflight.kind,
			detail: preflight.detail,
		});
		return;
	}

	const meta = getConversationMeta(conversation.id, task.userId);
	if (!meta) {
		settle(conversation.id, { kind: 'stopped' });
		return;
	}
	const inFlight = registerInFlight(conversation.id, endpoint, undefined, 'chat', task.modelId);
	inFlight.background = true;

	// The deadline bounds the wait in line, not the generation: once the slot is
	// granted the run finishes, however late. Aborting the in-flight controller
	// while still queued drops the turn out of line (the relay closes quietly).
	let deadlineHit = false;
	const deadlineTimer = setTimeout(
		() => {
			if (inFlight.generationStartedAt !== null) return;
			deadlineHit = true;
			inFlight.controller.abort();
		},
		Math.max(0, slotAt + task.deadlineMinutes * 60_000 - Date.now()),
	);
	deadlineTimer.unref?.();

	const outcome = await new Promise<TurnOutcome>((resolve, reject) => {
		startChatTurn({
			conversationId: conversation.id,
			userId: task.userId,
			meta,
			endpoint,
			model: parsed,
			disabledFeatures: meta.disabledFeatures,
			inFlight,
			userMessage,
			allowTools: true,
			toolPolicy: task.toolPolicy,
			slotPurpose: 'scheduled',
			slotPriority: 'background',
			// The runner notifies — with wording for each ending, which the relay's
			// one "new message" push can't give.
			suppressNotify: true,
			suppressTitleTask: true,
			onGenerationSettled: () => clearInFlight(conversation.id, inFlight),
			onComplete: () => clearInFlight(conversation.id, inFlight),
			onOutcome: resolve,
		})
			// Nobody reads the stream: cancel it so frames don't pile up in its
			// queue. Recording runs on its own branch of the tee, unaffected.
			.then((stream) => stream.cancel())
			.catch((e: unknown) => {
				clearInFlight(conversation.id, inFlight);
				reject(e instanceof Error ? e : new Error(String(e)));
			});
	}).finally(() => clearTimeout(deadlineTimer));

	if (deadlineHit && outcome.kind === 'stopped') {
		const detail = `The endpoint was busy until the deadline (${task.deadlineMinutes} min)`;
		failInConversation(conversation.id, userMessage.id, task.modelId, `Didn't run: ${detail}`);
		settle(conversation.id, { kind: 'failed', failureKind: 'deadline', detail });
		return;
	}
	settle(conversation.id, endingFor(outcome), inFlight.generationStartedAt);
}

function endingFor(outcome: TurnOutcome): RunEnding {
	switch (outcome.kind) {
		case 'done':
			return { kind: 'done', assistantMessageId: outcome.assistantMessageId };
		case 'halted_for_approval':
			return {
				kind: 'needs_input',
				assistantMessageId: outcome.assistantMessageId,
				toolNames: outcome.pendingToolNames,
			};
		case 'error':
			return { kind: 'failed', failureKind: 'upstream_error', detail: outcome.message };
		case 'stopped':
			return { kind: 'stopped' };
	}
}

/** Show a failure in the run's conversation, so opening it says what happened. */
function failInConversation(
	conversationId: string,
	parentMessageId: string,
	modelId: string,
	message: string,
): void {
	try {
		appendErrorSibling({
			conversationId,
			parentMessageId,
			message,
			modelUsed: modelId,
			advanceActiveLeaf: true,
		});
	} catch (e) {
		log.warn('could not record a failed run in its conversation:', errorMessage(e));
	}
}

/**
 * Record how a run ended: its row, the schedule's failure streak, the
 * notification, and retention. `conversationId` is null only when the run
 * failed before it could have one, and then nothing is notified: a push opens a
 * conversation.
 */
function settleRun(
	task: DueTask,
	runId: string,
	conversationId: string | null,
	ending: RunEnding,
	startedAt: number | null = null,
	opts: { notify?: boolean } = {},
): void {
	const now = Date.now();
	const cfg = getScheduledTasksConfig();
	const state =
		ending.kind === 'stopped'
			? 'skipped'
			: ending.kind === 'needs_input'
				? 'needs_input'
				: ending.kind;
	updateScheduledRun(runId, {
		state,
		failureKind:
			ending.kind === 'failed' ? ending.failureKind : ending.kind === 'stopped' ? 'stopped' : null,
		failureDetail: ending.kind === 'failed' ? ending.detail : null,
		...(startedAt !== null ? { startedAt } : {}),
		finishedAt: ending.kind === 'needs_input' ? null : now,
	});

	// A run waiting on approval is neither a success nor a failure yet, and a
	// stop was someone's choice; only the other two move the streak.
	let disabled = false;
	if (ending.kind === 'done' || ending.kind === 'failed') {
		disabled = recordScheduledTaskResult(
			task.id,
			ending.kind === 'done',
			cfg.disableAfterFailures,
			`Turned off after ${cfg.disableAfterFailures} failed runs in a row`,
		).disabled;
	}

	if (conversationId && ending.kind !== 'stopped' && opts.notify !== false) {
		notifyRun(task, conversationId, ending, disabled);
	}
	if (ending.kind !== 'needs_input') pruneRuns(task.id, task.userId, cfg.keepRuns);
}

function notifyRun(
	task: DueTask,
	conversationId: string,
	ending: RunEnding,
	disabled: boolean,
): void {
	const meta = getConversationMeta(conversationId, task.userId);
	if (!meta) return;
	const messageId =
		ending.kind === 'done' || ending.kind === 'needs_input'
			? ending.assistantMessageId
			: meta.activeLeafMessageId;
	if (!messageId) return;

	let summary: string | undefined;
	let previewText = '';
	if (ending.kind === 'done') {
		previewText = textOf(getMessage(conversationId, messageId));
	} else if (ending.kind === 'needs_input') {
		summary = `Waiting for your OK to use ${toolLabel(ending.toolNames[0])}`;
	} else if (ending.kind === 'failed') {
		summary = `Didn't finish: ${ending.detail}`;
	}
	if (disabled) summary = `${summary ?? 'Failed'} — schedule turned off`;

	void notifyConversationComplete({
		userId: task.userId,
		conversationId,
		assistantMessageId: messageId,
		conversationTitle: meta.title ?? task.name,
		previewText,
		modality: 'chat',
		...(summary ? { summary: buildPreview(summary) } : {}),
	}).catch((e) => log.warn('notify failed:', e));
}

function textOf(message: ChatMessage | null): string {
	if (!message) return '';
	return message.parts
		.filter((p): p is { type: 'text'; text: string } => p.type === 'text')
		.map((p) => p.text)
		.join('');
}

/** `mcp__mail__send_email` → `send_email`; the server reads from the title. */
function toolLabel(name: string | undefined): string {
	if (!name) return 'a tool';
	const m = /^mcp__.+?__(.+)$/.exec(name);
	return m ? m[1] : name;
}

/** "Morning brief — Oct 25"; an interval schedule that fires several times a
 *  day gets the time too. In the schedule's zone, like its cadence. */
export function runTitle(
	task: Pick<ScheduledTask, 'name' | 'cadence' | 'timezone'>,
	slotAt: number,
): string {
	const opts: Intl.DateTimeFormatOptions = {
		month: 'short',
		day: 'numeric',
		timeZone: task.timezone,
		...(task.cadence.kind === 'interval' ? { hour: 'numeric', minute: '2-digit' } : {}),
	};
	return `${task.name} — ${new Intl.DateTimeFormat('en-US', opts).format(slotAt)}`;
}

/** Delete run conversations past the schedule's retention. Best-effort: a
 *  failure here never affects the run that triggered it. */
function pruneRuns(scheduleId: string, userId: string, keep: number): void {
	try {
		for (const id of conversationsBeyondRetention(scheduleId, userId, keep)) {
			deleteConversation(id, userId);
		}
	} catch (e) {
		log.warn(`retention for schedule ${scheduleId} failed:`, errorMessage(e));
	}
}

// --- approval resume ---------------------------------------------------------

/**
 * The policy a paused turn in this conversation resumes under, if it is a
 * scheduled run's own turn still waiting on approval — the one case where
 * someone resumes a run rather than chatting in its conversation. Anything
 * typed into the conversation is an ordinary chat turn with the person present,
 * even while the run waits: so the paused turn must answer the run's prompt,
 * the root of the conversation (`branch` is the active branch, or its newest
 * window — the latest user message on it decides).
 */
export function scheduledPolicyForResume(
	conversationId: string,
	userId: string,
	scheduleId: string | null,
	task: ScheduledTask | null,
	branch: ReadonlyArray<Pick<ChatMessage, 'role' | 'parentMessageId'>>,
): { runId: string; policy: ScheduledToolPolicy } | null {
	if (!scheduleId || !task) return null;
	const lastUser = [...branch].reverse().find((m) => m.role === 'user');
	if (!lastUser || lastUser.parentMessageId) return null;
	const run = getScheduledRunForConversation(conversationId, userId);
	if (!run || run.state !== 'needs_input') return null;
	return { runId: run.id, policy: task.toolPolicy };
}

/** Settle a run the user just resumed by approving. No notification: they're
 *  looking at it. */
export function settleResumedRun(
	task: ScheduledTask,
	userId: string,
	runId: string,
	conversationId: string,
	outcome: TurnOutcome,
): void {
	settleRun({ ...task, userId }, runId, conversationId, endingFor(outcome), null, {
		notify: false,
	});
}

// --- restart -------------------------------------------------------------------

const SWEPT = Symbol.for('glyphstream.scheduledRunsSwept');
type GlobalWithFlag = typeof globalThis & { [SWEPT]?: boolean };

/**
 * Fail every run a restart cut off. A run's turn lives only in this process,
 * so a row a PREVIOUS process left queued or running has nothing behind it.
 * Only rows filed before this process started: the sweep waits for the first
 * tick, and a Run now pressed in the meantime is alive. Once per process — a
 * dev HMR reload re-evaluates this module, and running it again then would
 * fail runs that are very much alive.
 */
export function failInterruptedRuns(bootedAt = processBootedAt()): number {
	const g = globalThis as GlobalWithFlag;
	if (g[SWEPT]) return 0;
	g[SWEPT] = true;
	const runs = listUnsettledScheduledRuns(bootedAt);
	const cfg = getScheduledTasksConfig();
	for (const run of runs) {
		const detail = 'The server restarted before this run finished';
		updateScheduledRun(run.id, {
			state: 'failed',
			failureKind: 'interrupted',
			failureDetail: detail,
			finishedAt: Date.now(),
		});
		const { disabled } = recordScheduledTaskResult(
			run.scheduleId,
			false,
			cfg.disableAfterFailures,
			`Turned off after ${cfg.disableAfterFailures} failed runs in a row`,
		);
		if (!run.conversationId) continue;
		const meta = getConversationMeta(run.conversationId, run.userId);
		if (!meta?.activeLeafMessageId) continue;
		failInConversation(run.conversationId, meta.activeLeafMessageId, meta.modelId, detail);
		const task = getScheduledTask(run.scheduleId, run.userId);
		if (task) {
			notifyRun(
				{ ...task, userId: run.userId },
				run.conversationId,
				{ kind: 'failed', failureKind: 'interrupted', detail },
				disabled,
			);
		}
	}
	if (runs.length > 0) log.info(`failed ${runs.length} scheduled run(s) a restart interrupted`);
	return runs.length;
}

/** Test-only: let `failInterruptedRuns` run again. */
export function resetScheduledRunnerForTests(): void {
	(globalThis as GlobalWithFlag)[SWEPT] = false;
	running = false;
}

// --- lifecycle -------------------------------------------------------------------

const sweeper = createSweeper({
	name: 'scheduled',
	intervalMs: TICK_MS,
	initialDelayMs: INITIAL_DELAY_MS,
	enabled: () => getScheduledTasksConfig().enabled,
	// The restart sweep rides the first tick rather than `start()`: nothing may
	// touch the database at boot (the e2e harness reseeds it after the server is
	// up, and a handle opened before that reads a deleted file). It's
	// once-per-process, so later ticks skip it.
	sweep: () => {
		try {
			failInterruptedRuns();
		} catch (e) {
			log.warn('could not sweep interrupted runs:', errorMessage(e));
		}
		return runScheduledTaskSweep();
	},
});

export function startScheduledTaskRunner(): void {
	sweeper.start();
}

export function stopScheduledTaskRunner(): void {
	sweeper.stop();
}
