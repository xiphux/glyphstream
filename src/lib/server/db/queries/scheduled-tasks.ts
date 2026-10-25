/**
 * Scheduled tasks and their runs. Every read a user can reach is scoped by
 * `user_id`; the runner's cross-user reads (`listDueScheduledTasks`,
 * `listUnsettledScheduledRuns`) are the background sweep's, never a request's.
 */
import { and, asc, desc, eq, inArray, isNull, lte, notInArray, sql } from 'drizzle-orm';
import type {
	CustomModelParameters,
	FeatureCategory,
	ScheduleCadence,
	ScheduledRun,
	ScheduledRunFailureKind,
	ScheduledRunState,
	ScheduledTask,
	ScheduledToolPolicy,
} from '#lib/types/api.js';
import { generateId } from '../../util/id';
import { parseToolPolicy } from '../../scheduled/tool-policy';
import { getDb } from '../client';
import { isUniqueViolation } from '../errors';
import { scheduledRuns, scheduledTasks, users } from '../schema';
import { parseDisabledFeatures, parseModelParameters } from './json-columns';

type TaskRow = typeof scheduledTasks.$inferSelect;
type RunRow = typeof scheduledRuns.$inferSelect;

function parseCadenceColumn(raw: string): ScheduleCadence {
	// Written only by this module from a parsed cadence, so a parse failure is a
	// corrupt row; an empty weekday set gives it no slots, which the runner
	// treats as "never" rather than crashing the sweep.
	try {
		return JSON.parse(raw) as ScheduleCadence;
	} catch {
		return { kind: 'daily', time: '00:00', days: [] };
	}
}

function rowToTask(row: TaskRow): ScheduledTask {
	return {
		id: row.id,
		name: row.name,
		prompt: row.prompt,
		modelId: row.modelId,
		customModelId: row.customModelId,
		systemPrompt: row.systemPrompt,
		parameters: parseModelParameters(row.parametersJson),
		cadence: parseCadenceColumn(row.cadenceJson),
		timezone: row.timezone,
		toolPolicy: parseToolPolicy(row.toolPolicyJson),
		disabledFeatures: parseDisabledFeatures(row.disabledFeaturesJson),
		deadlineMinutes: row.deadlineMinutes,
		enabled: row.enabled,
		nextRunAt: row.nextRunAt,
		consecutiveFailures: row.consecutiveFailures,
		disabledReason: row.disabledReason,
		createdAt: row.createdAt,
		updatedAt: row.updatedAt,
	};
}

function rowToRun(row: RunRow): ScheduledRun {
	return {
		id: row.id,
		scheduleId: row.scheduleId,
		conversationId: row.conversationId,
		slotAt: row.slotAt,
		trigger: row.trigger,
		state: row.state,
		failureKind: row.failureKind as ScheduledRunFailureKind | null,
		failureDetail: row.failureDetail,
		createdAt: row.createdAt,
		startedAt: row.startedAt,
		finishedAt: row.finishedAt,
	};
}

/** The fields a user sets. Everything else is the runner's bookkeeping. */
export interface ScheduledTaskInput {
	name: string;
	prompt: string;
	modelId: string;
	customModelId: string | null;
	systemPrompt: string | null;
	parameters: CustomModelParameters | null;
	cadence: ScheduleCadence;
	timezone: string;
	toolPolicy: ScheduledToolPolicy;
	disabledFeatures: readonly FeatureCategory[];
	deadlineMinutes: number;
	enabled: boolean;
}

function inputColumns(input: ScheduledTaskInput) {
	return {
		name: input.name,
		prompt: input.prompt,
		modelId: input.modelId,
		customModelId: input.customModelId,
		systemPrompt: input.systemPrompt,
		parametersJson: input.parameters ? JSON.stringify(input.parameters) : null,
		cadenceJson: JSON.stringify(input.cadence),
		timezone: input.timezone,
		toolPolicyJson: JSON.stringify(input.toolPolicy),
		disabledFeaturesJson:
			input.disabledFeatures.length > 0 ? JSON.stringify(input.disabledFeatures) : null,
		deadlineMinutes: input.deadlineMinutes,
		enabled: input.enabled,
	};
}

/** `nextRunAt` is computed by the caller (from the cadence), null if disabled. */
export function createScheduledTask(
	userId: string,
	input: ScheduledTaskInput,
	nextRunAt: number | null,
	now = Date.now(),
): ScheduledTask {
	const row = getDb()
		.insert(scheduledTasks)
		.values({
			id: generateId(),
			userId,
			...inputColumns(input),
			nextRunAt: input.enabled ? nextRunAt : null,
			createdAt: now,
			updatedAt: now,
		})
		.returning()
		.get();
	return rowToTask(row);
}

/** Replace the user-set fields. Saving re-arms the schedule: the failure streak
 *  and any self-disable reason are cleared, since the user has now looked. */
export function updateScheduledTask(
	id: string,
	userId: string,
	input: ScheduledTaskInput,
	nextRunAt: number | null,
	now = Date.now(),
): ScheduledTask | null {
	const row = getDb()
		.update(scheduledTasks)
		.set({
			...inputColumns(input),
			nextRunAt: input.enabled ? nextRunAt : null,
			consecutiveFailures: 0,
			disabledReason: null,
			updatedAt: now,
		})
		.where(and(eq(scheduledTasks.id, id), eq(scheduledTasks.userId, userId)))
		.returning()
		.get();
	return row ? rowToTask(row) : null;
}

export function deleteScheduledTask(id: string, userId: string): boolean {
	const row = getDb()
		.delete(scheduledTasks)
		.where(and(eq(scheduledTasks.id, id), eq(scheduledTasks.userId, userId)))
		.returning({ id: scheduledTasks.id })
		.get();
	return row !== undefined;
}

export function getScheduledTask(id: string, userId: string): ScheduledTask | null {
	const row = getDb()
		.select()
		.from(scheduledTasks)
		.where(and(eq(scheduledTasks.id, id), eq(scheduledTasks.userId, userId)))
		.get();
	return row ? rowToTask(row) : null;
}

export function listScheduledTasks(userId: string): ScheduledTask[] {
	return getDb()
		.select()
		.from(scheduledTasks)
		.where(eq(scheduledTasks.userId, userId))
		.orderBy(asc(scheduledTasks.createdAt), asc(scheduledTasks.id))
		.all()
		.map(rowToTask);
}

export function countScheduledTasks(userId: string): number {
	const row = getDb()
		.select({ n: sql<number>`count(*)` })
		.from(scheduledTasks)
		.where(eq(scheduledTasks.userId, userId))
		.get();
	return row?.n ?? 0;
}

/**
 * Enabled schedules whose slot has come, for every user still allowed in —
 * a disabled account's schedules wait (they resume where the cadence is if
 * the account is re-enabled; the missed slots are not replayed). Oldest slot
 * first, so a backlog drains fairly.
 */
export function listDueScheduledTasks(
	now: number,
	limit: number,
): Array<ScheduledTask & { userId: string }> {
	return getDb()
		.select({ task: scheduledTasks })
		.from(scheduledTasks)
		.innerJoin(users, eq(users.id, scheduledTasks.userId))
		.where(
			and(
				eq(scheduledTasks.enabled, true),
				lte(scheduledTasks.nextRunAt, now),
				isNull(users.disabledAt),
			),
		)
		.orderBy(asc(scheduledTasks.nextRunAt), asc(scheduledTasks.id))
		.limit(limit)
		.all()
		.map(({ task }) => ({ ...rowToTask(task), userId: task.userId }));
}

/** Move the schedule to its next slot (the runner, after firing or skipping). */
export function setScheduledTaskNextRun(id: string, nextRunAt: number | null): void {
	getDb().update(scheduledTasks).set({ nextRunAt }).where(eq(scheduledTasks.id, id)).run();
}

/**
 * Record a run's result against the schedule's failure streak. A success
 * resets it; a failure extends it, and once it reaches `disableAfter` the
 * schedule turns itself off with `reason`. Returns whether this call disabled
 * it, so the caller can say so in the notification.
 */
export function recordScheduledTaskResult(
	id: string,
	ok: boolean,
	disableAfter: number,
	reason: string,
): { disabled: boolean } {
	const db = getDb();
	if (ok) {
		db.update(scheduledTasks)
			.set({ consecutiveFailures: 0 })
			.where(eq(scheduledTasks.id, id))
			.run();
		return { disabled: false };
	}
	const row = db
		.update(scheduledTasks)
		.set({ consecutiveFailures: sql`${scheduledTasks.consecutiveFailures} + 1` })
		.where(eq(scheduledTasks.id, id))
		.returning({
			failures: scheduledTasks.consecutiveFailures,
			enabled: scheduledTasks.enabled,
		})
		.get();
	if (!row || !row.enabled || row.failures < disableAfter) return { disabled: false };
	db.update(scheduledTasks)
		.set({ enabled: false, nextRunAt: null, disabledReason: reason })
		.where(eq(scheduledTasks.id, id))
		.run();
	return { disabled: true };
}

// --- runs --------------------------------------------------------------------

/**
 * File a run for `slotAt`, or return null if one already exists for that slot
 * — the unique index is what stops a tick racing itself (or a restart landing
 * mid-tick) from firing a slot twice.
 */
export function insertScheduledRun(input: {
	scheduleId: string;
	userId: string;
	slotAt: number;
	trigger: ScheduledRun['trigger'];
	state: ScheduledRunState;
	failureKind?: ScheduledRunFailureKind;
	failureDetail?: string;
	now?: number;
}): ScheduledRun | null {
	const now = input.now ?? Date.now();
	const settled = input.state !== 'queued' && input.state !== 'running';
	try {
		const row = getDb()
			.insert(scheduledRuns)
			.values({
				id: generateId(),
				scheduleId: input.scheduleId,
				userId: input.userId,
				slotAt: input.slotAt,
				trigger: input.trigger,
				state: input.state,
				failureKind: input.failureKind ?? null,
				failureDetail: input.failureDetail ?? null,
				createdAt: now,
				finishedAt: settled ? now : null,
			})
			.returning()
			.get();
		return rowToRun(row);
	} catch (e) {
		if (isUniqueViolation(e)) return null;
		throw e;
	}
}

export function updateScheduledRun(
	id: string,
	patch: Partial<
		Pick<
			RunRow,
			'conversationId' | 'state' | 'failureKind' | 'failureDetail' | 'startedAt' | 'finishedAt'
		>
	>,
): void {
	getDb().update(scheduledRuns).set(patch).where(eq(scheduledRuns.id, id)).run();
}

/** The latest run for the conversation a scheduled run created — what the
 *  approval resume reads to settle a run that was waiting on it. */
export function getScheduledRunForConversation(
	conversationId: string,
	userId: string,
): ScheduledRun | null {
	const row = getDb()
		.select()
		.from(scheduledRuns)
		.where(and(eq(scheduledRuns.conversationId, conversationId), eq(scheduledRuns.userId, userId)))
		.orderBy(desc(scheduledRuns.createdAt))
		.get();
	return row ? rowToRun(row) : null;
}

export function listScheduledRuns(
	scheduleId: string,
	userId: string,
	limit: number,
): ScheduledRun[] {
	return getDb()
		.select()
		.from(scheduledRuns)
		.where(and(eq(scheduledRuns.scheduleId, scheduleId), eq(scheduledRuns.userId, userId)))
		.orderBy(desc(scheduledRuns.createdAt), desc(scheduledRuns.id))
		.limit(limit)
		.all()
		.map(rowToRun);
}

/** The most recent run of each of these schedules, for the list page. */
export function latestScheduledRuns(
	scheduleIds: readonly string[],
	userId: string,
): Map<string, ScheduledRun> {
	const out = new Map<string, ScheduledRun>();
	if (scheduleIds.length === 0) return out;
	const rows = getDb()
		.select()
		.from(scheduledRuns)
		.where(
			and(
				inArray(scheduledRuns.scheduleId, [...scheduleIds]),
				eq(scheduledRuns.userId, userId),
				eq(
					scheduledRuns.createdAt,
					sql`(select max(r2.created_at) from scheduled_runs r2 where r2.schedule_id = ${scheduledRuns.scheduleId})`,
				),
			),
		)
		.all();
	for (const row of rows) out.set(row.scheduleId, rowToRun(row));
	return out;
}

/** Runs still queued or running — at startup, the ones a restart cut off. */
export function listUnsettledScheduledRuns(): Array<ScheduledRun & { userId: string }> {
	return getDb()
		.select()
		.from(scheduledRuns)
		.where(inArray(scheduledRuns.state, ['queued', 'running']))
		.all()
		.map((row) => ({ ...rowToRun(row), userId: row.userId }));
}

/**
 * The conversations of a schedule's runs past the newest `keep`, for retention.
 * Returns ids only — deleting a conversation is the conversations module's job
 * (media refs, the summary overview), and the run rows themselves are kept so
 * the history still shows the run happened.
 */
export function conversationsBeyondRetention(
	scheduleId: string,
	userId: string,
	keep: number,
): string[] {
	const keepIds = getDb()
		.select({ id: scheduledRuns.id })
		.from(scheduledRuns)
		.where(and(eq(scheduledRuns.scheduleId, scheduleId), eq(scheduledRuns.userId, userId)))
		.orderBy(desc(scheduledRuns.createdAt), desc(scheduledRuns.id))
		.limit(keep)
		.all()
		.map((r) => r.id);
	return getDb()
		.select({ conversationId: scheduledRuns.conversationId })
		.from(scheduledRuns)
		.where(
			and(
				eq(scheduledRuns.scheduleId, scheduleId),
				eq(scheduledRuns.userId, userId),
				sql`${scheduledRuns.conversationId} is not null`,
				keepIds.length > 0 ? notInArray(scheduledRuns.id, keepIds) : sql`1 = 1`,
				notInArray(scheduledRuns.state, ['queued', 'running', 'needs_input']),
			),
		)
		.all()
		.map((r) => r.conversationId!);
}
