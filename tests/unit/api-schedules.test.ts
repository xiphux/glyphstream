/**
 * Route tests for /api/user/schedules: validation, per-user scoping, the
 * operator's cap and off switch, and Run now.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDb, closeTestDb } from './_helpers/test-db';
import { seedUser } from './_helpers/seed';

const mocks = vi.hoisted(() => ({
	config: {
		enabled: true,
		maxPerUser: null as number | null,
		minIntervalHours: 2,
		defaultDeadlineMinutes: 90,
		keepRuns: 30,
		disableAfterFailures: 3,
	},
	models: [{ endpointId: 'mock', upstreamId: 'chat', kind: 'chat' }] as Array<{
		endpointId: string;
		upstreamId: string;
		kind: string;
	}>,
	started: [] as Array<{ id: string; userId: string; trigger: string }>,
}));

vi.mock('#lib/server/endpoints/registry.js', () => ({
	getEndpoint: (id: string) => (id === 'mock' ? { id: 'mock' } : undefined),
}));
vi.mock('#lib/server/endpoints/list-models.js', () => ({
	listAllModels: async () => mocks.models,
}));
vi.mock('#lib/server/endpoints/config.js', async (orig) => ({
	...(await orig<typeof import('#lib/server/endpoints/config.js')>()),
	getScheduledTasksConfig: () => mocks.config,
}));
vi.mock('#lib/server/scheduled/runner.js', () => ({
	startScheduledRun: (task: { id: string; userId: string }, _slot: number, trigger: string) => {
		mocks.started.push({ id: task.id, userId: task.userId, trigger });
		return 'run-1';
	},
}));

import * as list from '../../src/routes/api/user/schedules/+server';
import * as one from '../../src/routes/api/user/schedules/[id]/+server';
import * as runNow from '../../src/routes/api/user/schedules/[id]/run/+server';
import * as runs from '../../src/routes/api/user/schedules/[id]/runs/+server';
import { createCustomModel } from '#lib/server/db/queries/custom-models.js';
import type { ScheduledTask, ScheduledTasksResponse } from '#lib/types/api.js';

type User = { id: string; role: 'admin' | 'user' };
function event(user: User, body?: unknown, params: Record<string, string> = {}) {
	return {
		locals: { user },
		params,
		request: new Request('http://x/api/user/schedules', {
			method: body === undefined ? 'GET' : 'POST',
			headers: { 'content-type': 'application/json' },
			...(body === undefined ? {} : { body: JSON.stringify(body) }),
		}),
	} as never;
}
/** The status a handler answers with, whether it returns or throws (a kit
 *  `error()` throws — synchronously, from a sync handler). */
async function status(call: () => Promise<Response> | Response): Promise<number> {
	try {
		return (await call()).status;
	} catch (e) {
		return (e as { status: number }).status;
	}
}

const valid = {
	name: 'Morning brief',
	prompt: 'Summarize the news',
	modelId: 'mock::chat',
	cadence: { kind: 'daily', time: '07:00', days: [1, 2, 3, 4, 5] },
	timezone: 'America/New_York',
	toolPolicy: { allowed: ['mcp__mail__search'], ask: [], memoryWrites: false },
	disabledFeatures: [],
};

let user: User;
beforeEach(() => {
	createTestDb();
	user = { id: seedUser().id, role: 'user' };
	mocks.config = { ...mocks.config, enabled: true, maxPerUser: null };
	mocks.started = [];
});
afterEach(() => closeTestDb());

async function create(body: unknown = valid, as = user): Promise<ScheduledTask> {
	const res = await list.POST(event(as, body));
	expect(res.status).toBe(201);
	return ((await res.json()) as { schedule: ScheduledTask }).schedule;
}

describe('POST /api/user/schedules', () => {
	it('creates a schedule armed at its first slot, with the default deadline', async () => {
		const s = await create();
		expect(s).toMatchObject({ name: 'Morning brief', deadlineMinutes: 90, enabled: true });
		expect(s.nextRunAt).toBeGreaterThan(Date.now());
	});

	it.each([
		[{ ...valid, name: '' }, 400],
		[{ ...valid, name: 'two\nlines' }, 400],
		[{ ...valid, prompt: '   ' }, 400],
		[{ ...valid, modelId: 'gone::chat' }, 400],
		[{ ...valid, timezone: 'Mars/Olympus' }, 400],
		[{ ...valid, cadence: { kind: 'interval', everyHours: 1, anchorAt: 0 } }, 400],
		[{ ...valid, deadlineMinutes: 1 }, 400],
		[{ ...valid, enabled: 'yes' }, 400],
	])('rejects %j', async (body, code) => {
		expect(await status(() => list.POST(event(user, body)))).toBe(code);
	});

	it('refuses a non-chat model', async () => {
		mocks.models = [{ endpointId: 'mock', upstreamId: 'chat', kind: 'image' }];
		expect(await status(() => list.POST(event(user, valid)))).toBe(400);
		mocks.models = [{ endpointId: 'mock', upstreamId: 'chat', kind: 'chat' }];
	});

	it("copies a custom model's base model, prompt and parameters in at save time", async () => {
		const cm = createCustomModel({
			userId: user.id,
			name: 'Terse',
			description: null,
			baseEndpointId: 'mock',
			baseModelId: 'chat',
			systemPrompt: 'Be terse.',
			parameters: { temperature: 0.1 },
		});
		const s = await create({ ...valid, modelId: undefined, customModelId: cm.id });
		expect(s).toMatchObject({
			modelId: 'mock::chat',
			customModelId: cm.id,
			systemPrompt: 'Be terse.',
			parameters: { temperature: 0.1 },
		});
	});

	it("holds a non-admin to the operator's cap, but not an admin", async () => {
		mocks.config = { ...mocks.config, maxPerUser: 1 };
		await create();
		expect(await status(() => list.POST(event(user, valid)))).toBe(403);
		const admin: User = { id: seedUser().id, role: 'admin' };
		await create(valid, admin);
		await create(valid, admin);
	});

	it('reads as absent when the operator turned the feature off', async () => {
		mocks.config = { ...mocks.config, enabled: false };
		expect(await status(() => list.POST(event(user, valid)))).toBe(404);
		expect(await status(() => list.GET(event(user)))).toBe(404);
	});
});

describe('one schedule', () => {
	it("lists only the caller's schedules", async () => {
		const mine = await create();
		const other: User = { id: seedUser().id, role: 'user' };
		await create(valid, other);
		const body = (await (await list.GET(event(user))).json()) as ScheduledTasksResponse;
		expect(body.schedules.map((s) => s.id)).toEqual([mine.id]);
		expect(body.schedules[0].lastRun).toBeNull();
	});

	it("404s on another user's schedule for every verb", async () => {
		const theirs = await create(valid, { id: seedUser().id, role: 'user' });
		const params = { id: theirs.id };
		expect(await status(() => one.PUT(event(user, valid, params)))).toBe(404);
		expect(await status(() => one.PATCH(event(user, { enabled: false }, params)))).toBe(404);
		expect(await status(() => one.DELETE(event(user, undefined, params)))).toBe(404);
		expect(await status(() => runNow.POST(event(user, undefined, params)))).toBe(404);
		expect(await status(() => runs.GET(event(user, undefined, params)))).toBe(404);
		expect(mocks.started).toEqual([]);
	});

	it('disarms a schedule saved as disabled', async () => {
		const s = await create();
		const res = await one.PUT(event(user, { ...valid, enabled: false }, { id: s.id }));
		expect(((await res.json()) as { schedule: ScheduledTask }).schedule.nextRunAt).toBeNull();
	});

	it('toggles on and off without touching the rest', async () => {
		const s = await create();
		const patch = (enabled: unknown) => one.PATCH(event(user, { enabled }, { id: s.id }));
		const off = ((await (await patch(false)).json()) as { schedule: ScheduledTask }).schedule;
		expect(off).toMatchObject({ enabled: false, nextRunAt: null, name: s.name });
		const on = ((await (await patch(true)).json()) as { schedule: ScheduledTask }).schedule;
		expect(on.enabled).toBe(true);
		expect(on.nextRunAt).toBe(s.nextRunAt);
		expect(await status(() => patch('yes'))).toBe(400);
	});

	it('Run now starts a manual run, even while the schedule is off', async () => {
		const s = await create({ ...valid, enabled: false });
		const res = await runNow.POST(event(user, undefined, { id: s.id }));
		expect(res.status).toBe(202);
		expect(mocks.started).toEqual([{ id: s.id, userId: user.id, trigger: 'manual' }]);
	});

	it('deletes', async () => {
		const s = await create();
		expect((await one.DELETE(event(user, undefined, { id: s.id }))).status).toBe(204);
		expect(await status(() => runs.GET(event(user, undefined, { id: s.id })))).toBe(404);
	});
});
