/**
 * The scheduled-task runner end to end: a due schedule becomes a run, the run
 * a real chat turn (the relay is real; only the upstream, MCP and push are
 * stubbed), and every way a run ends is recorded, notified and counted.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDb, closeTestDb, type TestDB } from './_helpers/test-db';
import { seedUser } from './_helpers/seed';
import type { LoadedEndpoint } from '#lib/server/endpoints/config.js';

const ENDPOINT = {
	id: 'mock',
	displayName: 'Mock',
	baseUrl: 'http://localhost/v1',
	apiKey: null,
	requestTimeoutSeconds: 120,
	providerQuirk: 'passthrough',
	groupBy: 'endpoint',
	supportsTools: true,
	maxConcurrent: 1,
	resourceGroup: 'mock',
	resourceGroupMaxConcurrent: 1,
	release: null,
	contextWindow: null,
	modelContextWindows: {},
	modelPromptStyles: {},
	modelPromptHints: {},
} as unknown as LoadedEndpoint;

const mocks = vi.hoisted(() => ({
	testDb: null as unknown as TestDB,
	upstream: [] as Array<() => Response>,
	upstreamBodies: [] as Array<{ tools?: Array<{ function: { name: string } }> }>,
	preflight: { ok: true } as
		| { ok: true }
		| { ok: false; kind: 'mcp_unavailable' | 'mcp_credentials'; detail: string }
		| Error,
	config: {
		enabled: true,
		maxPerUser: null as number | null,
		minIntervalHours: 1,
		defaultDeadlineMinutes: 120,
		keepRuns: 30,
		disableAfterFailures: 3,
	},
}));

vi.mock('#lib/server/endpoints/client.js', async (orig) => ({
	...(await orig<typeof import('#lib/server/endpoints/client.js')>()),
	chatCompletionStream: vi.fn(
		async (_endpoint: unknown, body: (typeof mocks.upstreamBodies)[0]) => {
			mocks.upstreamBodies.push(body);
			const next = mocks.upstream.shift();
			if (!next) throw new Error('no canned upstream response left');
			return next();
		},
	),
}));
vi.mock('#lib/server/endpoints/registry.js', () => ({
	getEndpoint: (id: string) => (id === 'mock' ? ENDPOINT : undefined),
}));
vi.mock('#lib/server/endpoints/list-models.js', () => ({
	listAllModels: async () => [{ endpointId: 'mock', upstreamId: 'm', supportsTools: true }],
}));
vi.mock('#lib/server/endpoints/config.js', async (orig) => ({
	...(await orig<typeof import('#lib/server/endpoints/config.js')>()),
	getScheduledTasksConfig: () => mocks.config,
	getMaxToolLoopIterations: () => 4,
}));
// Built-in tools read config to decide availability; the test registers its own.
vi.mock('#lib/server/tools/index.js', async () => await import('#lib/server/tools/registry.js'));
vi.mock('#lib/server/mcp/bootstrap.js', () => ({ awaitMcpReady: async () => {} }));
vi.mock('#lib/server/mcp/registry.js', () => ({
	getUserServerStates: async () => [],
	listServerCatalog: () => [],
	getMcpServerCfg: () => undefined,
}));
vi.mock('#lib/server/mcp/tool-bridge.js', () => ({
	buildUserMcpToolDefinitions: async () => [],
	buildUserDeferredToolCatalog: async () => [],
	registerUserMcpTools: async () => {},
}));
vi.mock('#lib/server/scheduled/preflight.js', () => ({
	preflightMcp: async () => {
		if (mocks.preflight instanceof Error) throw mocks.preflight;
		return mocks.preflight;
	},
}));
vi.mock('#lib/server/push/notify.js', async (orig) => ({
	...(await orig<typeof import('#lib/server/push/notify.js')>()),
	notifyConversationComplete: vi.fn(async () => {}),
}));
vi.mock('#lib/server/tasks/title-task-runner.js', () => ({
	startTitleTaskIfFirstExchange: vi.fn(() => Promise.resolve(null)),
}));

import { notifyConversationComplete } from '#lib/server/push/notify.js';
import {
	createScheduledTask,
	getScheduledTask,
	insertScheduledRun,
	listScheduledRuns,
	updateScheduledRun,
	type ScheduledTaskInput,
} from '#lib/server/db/queries/scheduled-tasks.js';
import { createConversation, getConversationMeta } from '#lib/server/db/queries/conversations.js';
import { appendMessage, walkActiveBranch } from '#lib/server/db/queries/messages.js';
import {
	acquireEndpointSlot,
	resetEndpointGatesForTests,
} from '#lib/server/endpoints/concurrency.js';
import { _resetForTests, register } from '#lib/server/tools/registry.js';
import {
	activeConversationIds,
	countInFlight,
	resetInFlight,
} from '#lib/server/streaming/in-flight.js';
import {
	failInterruptedRuns,
	resetScheduledRunnerForTests,
	runScheduledTaskSweep,
	runTitle,
	startScheduledRun,
} from '#lib/server/scheduled/runner.js';
import { MAX_JITTER_MS } from '#lib/server/scheduled/cadence.js';
import type { ScheduledRun, ScheduledTask } from '#lib/types/api.js';

const notify = vi.mocked(notifyConversationComplete);

function sse(records: object[]): Response {
	const enc = new TextEncoder();
	return new Response(
		new ReadableStream<Uint8Array>({
			start(c) {
				for (const r of records) c.enqueue(enc.encode(`data: ${JSON.stringify(r)}\n\n`));
				c.enqueue(enc.encode('data: [DONE]\n\n'));
				c.close();
			},
		}),
		{ status: 200 },
	);
}
const reply = (text: string) => () =>
	sse([
		{ choices: [{ delta: { content: text }, finish_reason: null }] },
		{ choices: [{ delta: {}, finish_reason: 'stop' }] },
	]);
const callTool = (name: string) => () =>
	sse([
		{
			choices: [
				{
					delta: {
						tool_calls: [
							{ index: 0, id: 'call_1', type: 'function', function: { name, arguments: '{}' } },
						],
					},
					finish_reason: null,
				},
			],
		},
		{ choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
	]);

function input(overrides: Partial<ScheduledTaskInput> = {}): ScheduledTaskInput {
	return {
		name: 'Morning brief',
		prompt: 'Summarize the news',
		modelId: 'mock::m',
		customModelId: null,
		systemPrompt: null,
		parameters: null,
		cadence: { kind: 'daily', time: '07:00', days: [0, 1, 2, 3, 4, 5, 6] },
		timezone: 'UTC',
		toolPolicy: { allowed: [], ask: [], memoryWrites: false },
		disabledFeatures: ['reactions'],
		deadlineMinutes: 120,
		enabled: true,
		...overrides,
	};
}

const SLOT = Date.UTC(2026, 9, 25, 7, 0);
/** Past the slot and every schedule's jitter. */
const NOW = SLOT + MAX_JITTER_MS;

function schedule(overrides: Partial<ScheduledTaskInput> = {}, nextRunAt = SLOT) {
	const u = seedUser();
	const task = createScheduledTask(u.id, input(overrides), nextRunAt, SLOT - 86_400_000);
	return { userId: u.id, task };
}

/** Wait until the schedule's latest run has stopped moving. */
async function settled(task: ScheduledTask, userId: string): Promise<ScheduledRun> {
	for (let i = 0; i < 200; i++) {
		const [run] = listScheduledRuns(task.id, userId, 1);
		if (run && run.state !== 'queued' && run.state !== 'running') {
			// The notification is fired after the row is written.
			await new Promise((r) => setTimeout(r, 5));
			return run;
		}
		await new Promise((r) => setTimeout(r, 5));
	}
	throw new Error('run never settled');
}

beforeEach(() => {
	mocks.testDb = createTestDb();
	mocks.upstream = [];
	mocks.upstreamBodies = [];
	mocks.preflight = { ok: true };
	mocks.config = { ...mocks.config, keepRuns: 30, disableAfterFailures: 3 };
	notify.mockClear();
	_resetForTests();
	resetScheduledRunnerForTests();
});
afterEach(() => {
	closeTestDb();
	resetInFlight();
	resetEndpointGatesForTests();
	_resetForTests();
});

describe('firing', () => {
	it('runs a due schedule as a chat turn in its own conversation, and notifies', async () => {
		const { userId, task } = schedule();
		mocks.upstream.push(reply('Here is your brief.'));

		expect(await runScheduledTaskSweep(NOW)).toBe(1);
		const run = await settled(task, userId);

		expect(run).toMatchObject({ state: 'done', trigger: 'schedule', slotAt: SLOT });
		const meta = getConversationMeta(run.conversationId!, userId)!;
		expect(meta).toMatchObject({ scheduleId: task.id, title: 'Morning brief — Oct 25' });
		const branch = walkActiveBranch(run.conversationId!);
		expect(branch.map((m) => [m.role, m.parts[0]])).toEqual([
			['user', { type: 'text', text: 'Summarize the news' }],
			['assistant', { type: 'text', text: 'Here is your brief.' }],
		]);
		expect(notify).toHaveBeenCalledWith(
			expect.objectContaining({
				conversationId: run.conversationId,
				assistantMessageId: branch[1].id,
				previewText: 'Here is your brief.',
			}),
		);
		expect(notify.mock.calls[0][0].summary).toBeUndefined();
		// Advanced to tomorrow's slot.
		expect(getScheduledTask(task.id, userId)?.nextRunAt).toBe(SLOT + 86_400_000);
	});

	it("waits out the schedule's jitter", async () => {
		const { task } = schedule();
		// At the slot itself only a zero-jitter schedule may fire; this id isn't
		// one unless the hash happens to land on 0.
		const fired = await runScheduledTaskSweep(SLOT);
		const { jitterFor } = await import('#lib/server/scheduled/cadence.js');
		expect(fired).toBe(jitterFor(task.id) === 0 ? 1 : 0);
	});

	it('runs only the latest of several missed slots, and says the rest were missed', async () => {
		// Due three days ago; the server was down. Today's slot is inside its deadline.
		const { userId, task } = schedule({}, SLOT - 3 * 86_400_000);
		mocks.upstream.push(reply('ok'));

		expect(await runScheduledTaskSweep(NOW)).toBe(1);
		await settled(task, userId);

		const runs = listScheduledRuns(task.id, userId, 10);
		expect(runs.map((r) => [r.slotAt, r.state, r.failureKind])).toEqual(
			expect.arrayContaining([
				[SLOT, 'done', null],
				[SLOT - 3 * 86_400_000, 'skipped', 'missed'],
			]),
		);
		expect(runs).toHaveLength(2);
	});

	it("doesn't run a slot whose deadline passed while the server was down", async () => {
		const { userId, task } = schedule({ deadlineMinutes: 60 });

		expect(await runScheduledTaskSweep(SLOT + 3 * 3_600_000)).toBe(0);
		expect(listScheduledRuns(task.id, userId, 10)).toMatchObject([
			{ state: 'skipped', failureKind: 'missed' },
		]);
		expect(getScheduledTask(task.id, userId)?.nextRunAt).toBe(SLOT + 86_400_000);
		expect(notify).not.toHaveBeenCalled();
	});

	it('titles an interval run with its time too', () => {
		const t = runTitle(
			{ name: 'Inbox', cadence: { kind: 'interval', everyHours: 4, anchorAt: 0 }, timezone: 'UTC' },
			SLOT,
		);
		expect(t).toBe('Inbox — Oct 25, 7:00 AM');
	});
});

describe('how a run can end', () => {
	it('fails with the upstream error, shown in the conversation and the notification', async () => {
		const { userId, task } = schedule();
		const { UpstreamError } = await import('#lib/server/endpoints/client.js');
		mocks.upstream.push(() => {
			throw new UpstreamError('model not loaded', 503, null);
		});

		startScheduledRun({ ...task, userId }, NOW, 'manual');
		const run = await settled(task, userId);

		expect(run).toMatchObject({
			state: 'failed',
			failureKind: 'upstream_error',
			trigger: 'manual',
		});
		expect(walkActiveBranch(run.conversationId!).at(-1)?.parts[0]).toMatchObject({ type: 'error' });
		expect(notify.mock.calls[0][0].summary).toMatch(/^Didn't finish: /);
		expect(getScheduledTask(task.id, userId)?.consecutiveFailures).toBe(1);
	});

	it('turns the schedule off after too many failures in a row, and says so', async () => {
		mocks.config = { ...mocks.config, disableAfterFailures: 1 };
		const { userId, task } = schedule();
		mocks.preflight = { ok: false, kind: 'mcp_unavailable', detail: 'Mail is unreachable' };

		startScheduledRun({ ...task, userId }, NOW, 'manual');
		const run = await settled(task, userId);

		expect(run).toMatchObject({ state: 'failed', failureKind: 'mcp_unavailable' });
		expect(walkActiveBranch(run.conversationId!).at(-1)?.parts[0]).toEqual({
			type: 'error',
			message: 'Mail is unreachable',
		});
		expect(notify.mock.calls[0][0].summary).toBe(
			"Didn't finish: Mail is unreachable — schedule turned off",
		);
		expect(getScheduledTask(task.id, userId)).toMatchObject({ enabled: false, nextRunAt: null });
		expect(mocks.upstreamBodies).toHaveLength(0);
	});

	it("fails in a conversation, and notifies, when the schedule's model is gone", async () => {
		const { userId, task } = schedule({ modelId: 'removed::m' });

		startScheduledRun({ ...task, userId }, NOW, 'manual');
		const run = await settled(task, userId);

		expect(run).toMatchObject({ state: 'failed', failureKind: 'model_unavailable' });
		expect(walkActiveBranch(run.conversationId!).at(-1)?.parts[0]).toMatchObject({
			type: 'error',
			message: 'The model "removed::m" is no longer configured',
		});
		expect(notify.mock.calls[0][0].summary).toMatch(/^Didn't finish: The model/);
		expect(mocks.upstreamBodies).toHaveLength(0);
	});

	it('reports a run that throws partway in its conversation, and notifies', async () => {
		const { userId, task } = schedule();
		mocks.preflight = new Error('boom');

		startScheduledRun({ ...task, userId }, NOW, 'manual');
		const run = await settled(task, userId);

		expect(run).toMatchObject({ state: 'failed', failureKind: 'internal', failureDetail: 'boom' });
		expect(walkActiveBranch(run.conversationId!).at(-1)?.parts[0]).toMatchObject({
			type: 'error',
			message: 'boom',
		});
		expect(notify).toHaveBeenCalledTimes(1);
	});

	it('pauses for an `ask` tool, and notifies that it needs an OK', async () => {
		register({
			definition: {
				type: 'function',
				function: { name: 'mcp__mail__send', description: 'send', parameters: { type: 'object' } },
			},
			metadata: { category: 'mcp:mail' },
			execute: () => {
				throw new Error('must not run before approval');
			},
		});
		const { userId, task } = schedule({
			toolPolicy: { allowed: [], ask: ['mcp__mail__send'], memoryWrites: false },
		});
		mocks.upstream.push(callTool('mcp__mail__send'));

		startScheduledRun({ ...task, userId }, NOW, 'manual');
		const run = await settled(task, userId);

		expect(run).toMatchObject({ state: 'needs_input', finishedAt: null });
		expect(notify.mock.calls[0][0].summary).toBe('Waiting for your OK to use send');
		// Waiting is neither a success nor a failure.
		expect(getScheduledTask(task.id, userId)?.consecutiveFailures).toBe(0);
	});

	it('offers only the tools in its policy', async () => {
		for (const name of ['mcp__mail__search', 'mcp__mail__delete', 'get_current_time']) {
			register({
				definition: {
					type: 'function',
					function: { name, description: name, parameters: { type: 'object' } },
				},
				metadata: { category: name.startsWith('mcp__') ? 'mcp:mail' : 'clock' },
				execute: () => ({ content: 'ok' }),
			});
		}
		const { userId, task } = schedule({
			toolPolicy: { allowed: ['mcp__mail__search'], ask: [], memoryWrites: false },
		});
		mocks.upstream.push(reply('ok'));

		startScheduledRun({ ...task, userId }, NOW, 'manual');
		await settled(task, userId);

		expect(mocks.upstreamBodies[0].tools?.map((t) => t.function.name).sort()).toEqual([
			'get_current_time',
			'mcp__mail__search',
		]);
	});

	it('is skipped if it gets no slot before its deadline, and queues as background work', async () => {
		const { userId, task } = schedule({ deadlineMinutes: 5 });
		const held = await acquireEndpointSlot(ENDPOINT, { work: { purpose: 'chat' } });

		// A slot five minutes ago with a five-minute deadline: it may queue, but
		// the deadline lands almost at once.
		startScheduledRun({ ...task, userId }, Date.now() - 5 * 60_000 + 30, 'manual');
		await new Promise((r) => setTimeout(r, 10));
		// Its in-flight entry doesn't count against the person's own cap.
		expect(countInFlight(activeConversationIds())).toBe(0);
		const run = await settled(task, userId);
		held.release();

		expect(run).toMatchObject({ state: 'failed', failureKind: 'deadline' });
		expect(walkActiveBranch(run.conversationId!).at(-1)?.parts[0]).toMatchObject({
			type: 'error',
			message: expect.stringMatching(/^Didn't run: The endpoint was busy/) as unknown,
		});
		expect(mocks.upstreamBodies).toHaveLength(0);
	});
});

describe('retention', () => {
	it("deletes run conversations past the schedule's keep count", async () => {
		mocks.config = { ...mocks.config, keepRuns: 1 };
		const { userId, task } = schedule();
		mocks.upstream.push(reply('one'), reply('two'));

		startScheduledRun({ ...task, userId }, NOW, 'manual');
		const first = await settled(task, userId);
		startScheduledRun({ ...task, userId }, NOW + 1, 'manual');
		const second = await settled(task, userId);

		expect(second.id).not.toBe(first.id);
		expect(getConversationMeta(first.conversationId!, userId)).toBeNull();
		expect(getConversationMeta(second.conversationId!, userId)).not.toBeNull();
		// The history still shows the first run happened.
		expect(listScheduledRuns(task.id, userId, 10)).toHaveLength(2);
	});
});

describe('restart', () => {
	it('fails the runs a restart cut off, once per process', () => {
		const { userId, task } = schedule();
		const conv = createConversation({
			userId,
			endpointId: 'mock',
			modelId: 'mock::m',
			modelKind: 'chat',
			scheduleId: task.id,
		});
		appendMessage({
			conversationId: conv.id,
			parentMessageId: null,
			role: 'user',
			parts: [{ type: 'text', text: 'brief' }],
		});
		const run = insertScheduledRun({
			scheduleId: task.id,
			userId,
			slotAt: SLOT,
			trigger: 'schedule',
			state: 'queued',
		})!;
		updateScheduledRun(run.id, { state: 'running', conversationId: conv.id });

		// As if the process started after the run was filed.
		expect(failInterruptedRuns(Date.now() + 1)).toBe(1);
		expect(failInterruptedRuns(Date.now() + 1)).toBe(0);
		expect(listScheduledRuns(task.id, userId, 1)[0]).toMatchObject({
			state: 'failed',
			failureKind: 'interrupted',
		});
		expect(walkActiveBranch(conv.id).at(-1)?.parts[0]).toMatchObject({ type: 'error' });
		expect(notify.mock.calls[0][0].summary).toMatch(/restarted/);
	});

	it('leaves a run this process started before the first tick alone', () => {
		const { userId, task } = schedule();
		const bootedAt = Date.now();
		const run = insertScheduledRun({
			scheduleId: task.id,
			userId,
			slotAt: SLOT,
			trigger: 'manual',
			state: 'queued',
			now: bootedAt,
		})!;
		expect(failInterruptedRuns(bootedAt)).toBe(0);
		expect(listScheduledRuns(task.id, userId, 1)[0]).toMatchObject({ id: run.id, state: 'queued' });
		expect(notify).not.toHaveBeenCalled();
	});
});
