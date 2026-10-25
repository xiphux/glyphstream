import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { closeTestDb, createTestDb, type TestDB } from './_helpers/test-db';
import { seedUser } from './_helpers/seed';
import {
	conversationsBeyondRetention,
	countScheduledTasks,
	createScheduledTask,
	deleteScheduledTask,
	getScheduledTask,
	insertScheduledRun,
	latestScheduledRuns,
	listDueScheduledTasks,
	listScheduledRuns,
	listScheduledTasks,
	listUnsettledScheduledRuns,
	recordScheduledTaskResult,
	updateScheduledRun,
	updateScheduledTask,
	type ScheduledTaskInput,
} from '#lib/server/db/queries/scheduled-tasks.js';
import { createConversation } from '#lib/server/db/queries/conversations.js';
import { users } from '#lib/server/db/schema.js';

let db: TestDB;
beforeEach(() => {
	db = createTestDb();
});
afterEach(() => closeTestDb());

function input(overrides: Partial<ScheduledTaskInput> = {}): ScheduledTaskInput {
	return {
		name: 'Morning brief',
		prompt: 'Summarize my inbox',
		modelId: 'bridge::m',
		customModelId: null,
		systemPrompt: null,
		parameters: null,
		cadence: { kind: 'daily', time: '07:00', days: [1, 2, 3, 4, 5] },
		timezone: 'America/New_York',
		toolPolicy: { allowed: ['mcp__mail__search'], ask: [], memoryWrites: false },
		disabledFeatures: [],
		deadlineMinutes: 120,
		enabled: true,
		...overrides,
	};
}

describe('scheduled task CRUD', () => {
	it('round-trips every user-set field', () => {
		const u = seedUser();
		const created = createScheduledTask(
			u.id,
			input({ parameters: { temperature: 0.2 }, disabledFeatures: ['web'] }),
			5000,
			1000,
		);
		expect(getScheduledTask(created.id, u.id)).toEqual({
			...created,
			name: 'Morning brief',
			parameters: { temperature: 0.2 },
			disabledFeatures: ['web'],
			cadence: { kind: 'daily', time: '07:00', days: [1, 2, 3, 4, 5] },
			toolPolicy: { allowed: ['mcp__mail__search'], ask: [], memoryWrites: false },
			nextRunAt: 5000,
			createdAt: 1000,
		});
	});

	it("never reads or writes another user's schedule", () => {
		const owner = seedUser();
		const other = seedUser();
		const task = createScheduledTask(owner.id, input(), 5000);

		expect(getScheduledTask(task.id, other.id)).toBeNull();
		expect(listScheduledTasks(other.id)).toEqual([]);
		expect(updateScheduledTask(task.id, other.id, input({ name: 'x' }), 1)).toBeNull();
		expect(deleteScheduledTask(task.id, other.id)).toBe(false);
		expect(getScheduledTask(task.id, owner.id)?.name).toBe('Morning brief');
		expect(countScheduledTasks(owner.id)).toBe(1);
	});

	it('holds no next run while disabled', () => {
		const u = seedUser();
		expect(createScheduledTask(u.id, input({ enabled: false }), 5000).nextRunAt).toBeNull();
	});

	it('clears the failure streak and self-disable reason when saved', () => {
		const u = seedUser();
		const task = createScheduledTask(u.id, input(), 5000);
		recordScheduledTaskResult(task.id, false, 1, 'Failed 1 time in a row');
		expect(getScheduledTask(task.id, u.id)).toMatchObject({
			enabled: false,
			disabledReason: 'Failed 1 time in a row',
		});

		const saved = updateScheduledTask(task.id, u.id, input(), 9000);
		expect(saved).toMatchObject({
			enabled: true,
			nextRunAt: 9000,
			consecutiveFailures: 0,
			disabledReason: null,
		});
	});
});

describe('listDueScheduledTasks', () => {
	it('returns enabled schedules whose slot has come, oldest first', () => {
		const u = seedUser();
		const late = createScheduledTask(u.id, input({ name: 'late' }), 200);
		const early = createScheduledTask(u.id, input({ name: 'early' }), 100);
		createScheduledTask(u.id, input({ name: 'future' }), 10_000);
		createScheduledTask(u.id, input({ name: 'off', enabled: false }), 50);

		const due = listDueScheduledTasks(1000, 10);
		expect(due.map((t) => t.id)).toEqual([early.id, late.id]);
		expect(due[0].userId).toBe(u.id);
	});

	it("skips a disabled account's schedules", () => {
		const u = seedUser();
		createScheduledTask(u.id, input(), 100);
		db.update(users).set({ disabledAt: 1 }).where(eq(users.id, u.id)).run();
		expect(listDueScheduledTasks(1000, 10)).toEqual([]);
	});
});

describe('recordScheduledTaskResult', () => {
	it('disables the schedule once failures reach the threshold, and only then', () => {
		const u = seedUser();
		const task = createScheduledTask(u.id, input(), 100);
		expect(recordScheduledTaskResult(task.id, false, 3, 'r')).toEqual({ disabled: false });
		expect(recordScheduledTaskResult(task.id, false, 3, 'r')).toEqual({ disabled: false });
		expect(recordScheduledTaskResult(task.id, false, 3, 'r')).toEqual({ disabled: true });
		expect(getScheduledTask(task.id, u.id)).toMatchObject({
			enabled: false,
			nextRunAt: null,
			consecutiveFailures: 3,
		});
		// Already off: a late failure doesn't "disable" it again.
		expect(recordScheduledTaskResult(task.id, false, 3, 'r')).toEqual({ disabled: false });
	});

	it('resets the streak on success', () => {
		const u = seedUser();
		const task = createScheduledTask(u.id, input(), 100);
		recordScheduledTaskResult(task.id, false, 3, 'r');
		recordScheduledTaskResult(task.id, false, 3, 'r');
		recordScheduledTaskResult(task.id, true, 3, 'r');
		expect(recordScheduledTaskResult(task.id, false, 3, 'r')).toEqual({ disabled: false });
		expect(getScheduledTask(task.id, u.id)?.consecutiveFailures).toBe(1);
	});
});

describe('scheduled runs', () => {
	it('files one run per slot — a second insert for the same slot is refused', () => {
		const u = seedUser();
		const task = createScheduledTask(u.id, input(), 100);
		const base = { scheduleId: task.id, userId: u.id, slotAt: 100, trigger: 'schedule' as const };
		expect(insertScheduledRun({ ...base, state: 'queued' })).not.toBeNull();
		expect(insertScheduledRun({ ...base, state: 'queued' })).toBeNull();
	});

	it('stamps finishedAt on a run filed already settled', () => {
		const u = seedUser();
		const task = createScheduledTask(u.id, input(), 100);
		const run = insertScheduledRun({
			scheduleId: task.id,
			userId: u.id,
			slotAt: 100,
			trigger: 'schedule',
			state: 'skipped',
			failureKind: 'missed',
			now: 777,
		});
		expect(run).toMatchObject({ state: 'skipped', failureKind: 'missed', finishedAt: 777 });
	});

	it('lists history newest first, scoped to the owner', () => {
		const u = seedUser();
		const other = seedUser();
		const task = createScheduledTask(u.id, input(), 100);
		for (const slotAt of [1, 2, 3]) {
			insertScheduledRun({
				scheduleId: task.id,
				userId: u.id,
				slotAt,
				trigger: 'schedule',
				state: 'done',
				now: slotAt,
			});
		}
		expect(listScheduledRuns(task.id, u.id, 2).map((r) => r.slotAt)).toEqual([3, 2]);
		expect(listScheduledRuns(task.id, other.id, 10)).toEqual([]);
		expect(latestScheduledRuns([task.id], u.id).get(task.id)?.slotAt).toBe(3);
		expect(latestScheduledRuns([task.id], other.id).size).toBe(0);
	});

	it('finds runs a restart cut off', () => {
		const u = seedUser();
		const task = createScheduledTask(u.id, input(), 100);
		const base = { scheduleId: task.id, userId: u.id, trigger: 'schedule' as const };
		const running = insertScheduledRun({ ...base, slotAt: 1, state: 'queued', now: 10 })!;
		updateScheduledRun(running.id, { state: 'running', startedAt: 5 });
		insertScheduledRun({ ...base, slotAt: 2, state: 'done', now: 10 });
		insertScheduledRun({ ...base, slotAt: 3, state: 'needs_input', now: 10 });
		// Filed by the current process: not cut off by anything.
		insertScheduledRun({ ...base, slotAt: 4, state: 'queued', now: 20 });

		expect(listUnsettledScheduledRuns(20).map((r) => [r.id, r.state])).toEqual([
			[running.id, 'running'],
		]);
	});

	it('keeps the run row when its conversation is deleted', () => {
		const u = seedUser();
		const task = createScheduledTask(u.id, input(), 100);
		const conv = createConversation({
			userId: u.id,
			endpointId: 'bridge',
			modelId: 'bridge::m',
			modelKind: 'chat',
		});
		const run = insertScheduledRun({
			scheduleId: task.id,
			userId: u.id,
			slotAt: 1,
			trigger: 'manual',
			state: 'done',
		})!;
		updateScheduledRun(run.id, { conversationId: conv.id });
		db.run(`delete from conversations where id = '${conv.id}'`);
		expect(listScheduledRuns(task.id, u.id, 10)[0]).toMatchObject({
			id: run.id,
			conversationId: null,
		});
	});

	it('names the conversations past the retention window, never unsettled ones', () => {
		const u = seedUser();
		const task = createScheduledTask(u.id, input(), 100);
		const convs: string[] = [];
		const states = ['done', 'needs_input', 'failed', 'done', 'done'] as const;
		states.forEach((state, i) => {
			const conv = createConversation({
				userId: u.id,
				endpointId: 'bridge',
				modelId: 'bridge::m',
				modelKind: 'chat',
			});
			convs.push(conv.id);
			const run = insertScheduledRun({
				scheduleId: task.id,
				userId: u.id,
				slotAt: i,
				trigger: 'schedule',
				state,
				now: i,
			})!;
			updateScheduledRun(run.id, { conversationId: conv.id });
		});

		// Keep the newest two (slots 4 and 3); of the rest, the needs_input run
		// (slot 1) is still waiting on its user, so it stays.
		expect(conversationsBeyondRetention(task.id, u.id, 2).sort()).toEqual(
			[convs[0], convs[2]].sort(),
		);
	});
});
