import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDb, closeTestDb } from './_helpers/test-db';
import { seedUser } from './_helpers/seed';

// Mock the inference call + the model resolver; let the real generateMemoryTopic,
// fallbackTopic, and the real DB queries run against the test DB.
const chatMock = vi.hoisted(() => vi.fn());
vi.mock('#lib/server/endpoints/client.js', () => ({ chatCompletionSync: chatMock }));

const taskModelMock = vi.hoisted(() => vi.fn());
vi.mock('#lib/server/tasks/task-model.js', () => ({ getTaskModel: taskModelMock }));

import { runTopicBackfillSweep } from '#lib/server/memory/topic-backfill.js';
import {
	acquireEndpointSlot,
	getResourceGroupSnapshot,
	resetEndpointGatesForTests,
} from '#lib/server/endpoints/concurrency.js';
import type { LoadedEndpoint } from '#lib/server/endpoints/config.js';
import { getDb } from '#lib/server/db/client.js';
import { modelStatsDaily } from '#lib/server/db/schema.js';
import {
	createMemory,
	listMemoriesNeedingTopic,
	listMemoryTierRows,
} from '#lib/server/db/queries/memories.js';

const ENDPOINT: LoadedEndpoint = {
	id: 'task',
	displayName: 'task',
	baseUrl: 'http://task/v1',
	apiKey: null,
	requestTimeoutSeconds: 120,
	providerQuirk: 'passthrough',
	groupBy: 'endpoint',
	supportsTools: false,
	maxConcurrent: 1,
	resourceGroup: 'task',
	resourceGroupMaxConcurrent: 1,
	release: null,
	contextWindow: null,
	modelContextWindows: {},
	modelPromptStyles: {},
	modelPromptHints: {},
};
const MODEL = { endpoint: ENDPOINT, upstreamId: 'm' };

function reply(content: string) {
	chatMock.mockResolvedValue({ choices: [{ message: { content } }] });
}

beforeEach(() => {
	createTestDb();
	chatMock.mockReset();
	taskModelMock.mockReset();
	taskModelMock.mockReturnValue(MODEL);
	reply('Generated topic');
});

afterEach(() => {
	resetEndpointGatesForTests();
	closeTestDb();
});

describe('runTopicBackfillSweep', () => {
	it('is a no-op when no task model is configured', async () => {
		taskModelMock.mockReturnValue(null);
		const u = seedUser();
		createMemory(u.id, 'fact'); // null topic
		expect(await runTopicBackfillSweep()).toEqual({ filled: 0, drained: false });
		expect(chatMock).not.toHaveBeenCalled();
	});

	it('reports drained on an empty store', async () => {
		expect(await runTopicBackfillSweep()).toEqual({ filled: 0, drained: true });
	});

	it('fills null-topic rows and reports drained, across users', async () => {
		const u1 = seedUser();
		const u2 = seedUser();
		createMemory(u1.id, 'u1 fact');
		createMemory(u2.id, 'u2 fact');

		const r = await runTopicBackfillSweep();
		expect(r.filled).toBe(2);
		expect(r.drained).toBe(true);
		expect(listMemoriesNeedingTopic(100)).toHaveLength(0);
		expect(listMemoryTierRows(u1.id)[0].topic).toBe('Generated topic');
	});

	it('leaves already-labelled rows untouched', async () => {
		const u = seedUser();
		createMemory(u.id, 'labelled body', 'Original');
		createMemory(u.id, 'unlabelled body');

		await runTopicBackfillSweep();
		const rows = listMemoryTierRows(u.id);
		const labelled = rows.find((row) => row.snippet.startsWith('labelled'))!;
		const filled = rows.find((row) => row.snippet.startsWith('unlabelled'))!;
		expect(labelled.topic).toBe('Original'); // not overwritten
		expect(filled.topic).toBe('Generated topic');
	});

	it('writes a content-derived fallback when the model returns nothing usable', async () => {
		reply('   ');
		const u = seedUser();
		createMemory(u.id, 'the quick brown fox jumps over the lazy dog');
		await runTopicBackfillSweep();
		expect(listMemoryTierRows(u.id)[0].topic).toBe('the quick brown fox jumps over the lazy');
		expect(listMemoriesNeedingTopic(100)).toHaveLength(0); // drained via fallback
	});

	it('stops the sweep and leaves rows queued when the endpoint fails', async () => {
		chatMock.mockRejectedValue(new Error('endpoint down'));
		const u = seedUser();
		createMemory(u.id, 'fact');
		expect(await runTopicBackfillSweep()).toEqual({ filled: 0, drained: false });
		expect(listMemoriesNeedingTopic(100)).toHaveLength(1); // still queued for retry
	});

	it('holds a topic slot on the task endpoint while the call is in flight', async () => {
		let finish!: (v: unknown) => void;
		chatMock.mockImplementation(() => {
			const snap = getResourceGroupSnapshot('task');
			expect(snap?.holders).toEqual([
				expect.objectContaining({ purpose: 'topic', modelId: 'm', state: 'active' }),
			]);
			return new Promise((r) => (finish = r));
		});
		createMemory(seedUser().id, 'fact');

		const sweep = runTopicBackfillSweep();
		await vi.waitFor(() => expect(chatMock).toHaveBeenCalledOnce());
		finish({ choices: [{ message: { content: 'Topic' } }] });
		expect((await sweep).filled).toBe(1);
		expect(getResourceGroupSnapshot('task')?.holders).toEqual([]);
	});

	it('waits behind a holder of a capacity-1 endpoint and queues as background', async () => {
		const held = await acquireEndpointSlot(ENDPOINT, { work: { purpose: 'chat' } });
		createMemory(seedUser().id, 'fact');

		const sweep = runTopicBackfillSweep();
		await vi.waitFor(() =>
			expect(getResourceGroupSnapshot('task')?.queued).toEqual([
				expect.objectContaining({ purpose: 'topic', state: 'queued' }),
			]),
		);
		expect(chatMock).not.toHaveBeenCalled();

		// An interactive turn arriving later still goes ahead of the backlog.
		const turn = acquireEndpointSlot(ENDPOINT, { work: { purpose: 'chat' } });
		expect(getResourceGroupSnapshot('task')?.queued.map((q) => q.purpose)).toEqual([
			'chat',
			'topic',
		]);
		held.release();
		(await turn).release();

		expect((await sweep).filled).toBe(1);
		expect(chatMock).toHaveBeenCalledOnce();
	});

	it('gives up on the slot after one request-timeout, leaving rows queued', async () => {
		// Fake timers don't drive AbortSignal.timeout, so hand the sweep a signal
		// the test controls.
		const wait = new AbortController();
		const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(wait.signal);
		try {
			const held = await acquireEndpointSlot(ENDPOINT, { work: { purpose: 'chat' } });
			createMemory(seedUser().id, 'fact');

			const sweep = runTopicBackfillSweep();
			expect(timeout).toHaveBeenCalledWith(ENDPOINT.requestTimeoutSeconds * 1000);
			wait.abort(new DOMException('timed out', 'TimeoutError'));
			expect(await sweep).toEqual({ filled: 0, drained: false });
			expect(chatMock).not.toHaveBeenCalled();
			expect(listMemoriesNeedingTopic(100)).toHaveLength(1);
			expect(getResourceGroupSnapshot('task')?.queued).toEqual([]);
			held.release();
		} finally {
			timeout.mockRestore();
		}
	});

	it('counts each labelling call once as task:topic', async () => {
		const u = seedUser();
		createMemory(u.id, 'one');
		createMemory(u.id, 'two');
		await runTopicBackfillSweep();
		const rows = getDb()
			.select()
			.from(modelStatsDaily)
			.all()
			.filter((r) => r.metric === 'task:topic');
		expect(rows).toEqual([expect.objectContaining({ endpointId: 'task', modelId: 'm', count: 2 })]);
	});
});
