import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDb, closeTestDb, type TestDB } from './_helpers/test-db';
import { seedUser } from './_helpers/seed';

const mocks = vi.hoisted(() => ({ testDb: null as unknown as TestDB }));
vi.mock('$lib/server/db/client', () => ({
	getDb: () => mocks.testDb,
	closeDb: () => {},
}));

// Mock the inference call + the model resolver; let the real generateMemoryTopic,
// fallbackTopic, and the real DB queries run against the test DB.
const chatMock = vi.hoisted(() => vi.fn());
vi.mock('$lib/server/endpoints/client', () => ({ chatCompletionSync: chatMock }));

const taskModelMock = vi.hoisted(() => vi.fn());
vi.mock('$lib/server/tasks/task-model', () => ({ getTaskModel: taskModelMock }));

import {
	runTopicBackfillSweep,
	startTopicBackfiller,
	stopTopicBackfiller,
} from '$lib/server/memory/topic-backfill';
import {
	createMemory,
	listMemoriesNeedingTopic,
	listMemoryTierRows,
} from '$lib/server/db/queries/memories';

const MODEL = { endpoint: {}, upstreamId: 'm' };

function reply(content: string) {
	chatMock.mockResolvedValue({ choices: [{ message: { content } }] });
}

beforeEach(() => {
	mocks.testDb = createTestDb();
	chatMock.mockReset();
	taskModelMock.mockReset();
	taskModelMock.mockReturnValue(MODEL);
	reply('Generated topic');
});

afterEach(() => {
	// Defensive: make sure a lifecycle test never leaks a timer/generation into
	// the next test (each also cleans up in its own finally).
	stopTopicBackfiller();
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
});

describe('start/stop timer lifecycle', () => {
	// Hold the model call open so a sweep can be caught mid-flight. Returns a
	// `resolve` that completes the in-flight generation and a promise the tick
	// callback runs off of.
	function deferChat(): (content: string) => void {
		let resolve!: (v: unknown) => void;
		chatMock.mockImplementation(() => new Promise((res) => (resolve = res)));
		return (content: string) => resolve({ choices: [{ message: { content } }] });
	}

	it('stop() during an in-flight sweep does not re-arm the timer', async () => {
		vi.useFakeTimers();
		try {
			const u = seedUser();
			createMemory(u.id, 'needs a topic');
			const finishChat = deferChat();

			startTopicBackfiller();
			await vi.runOnlyPendingTimersAsync(); // fire the initial tick → sweep blocks on the model
			expect(chatMock).toHaveBeenCalledTimes(1);
			expect(vi.getTimerCount()).toBe(0); // nothing armed while the sweep is in flight

			stopTopicBackfiller(); // stop mid-sweep
			finishChat('Backfilled');
			await vi.advanceTimersByTimeAsync(0); // let the sweep + its .then complete

			// The completion callback must NOT have re-armed a timer.
			expect(vi.getTimerCount()).toBe(0);
		} finally {
			stopTopicBackfiller();
			vi.useRealTimers();
		}
	});

	it('stop() then start() mid-sweep leaves the restarted timer intact', async () => {
		vi.useFakeTimers();
		try {
			const u = seedUser();
			createMemory(u.id, 'needs a topic');
			const finishChat = deferChat();

			startTopicBackfiller();
			await vi.runOnlyPendingTimersAsync(); // sweep #1 in flight
			stopTopicBackfiller();
			startTopicBackfiller(); // restart while sweep #1 is still in flight
			expect(vi.getTimerCount()).toBe(1); // the restart armed exactly one timer

			// Sweep #1 completes — a shared boolean would let its callback null or
			// double the restart's timer; the generation token makes it a no-op.
			finishChat('Backfilled');
			await vi.advanceTimersByTimeAsync(0);
			expect(vi.getTimerCount()).toBe(1); // still exactly the restart's timer
		} finally {
			stopTopicBackfiller();
			vi.useRealTimers();
		}
	});

	it('does not mount a timer when no task model is configured', () => {
		vi.useFakeTimers();
		try {
			taskModelMock.mockReturnValue(null);
			startTopicBackfiller();
			expect(vi.getTimerCount()).toBe(0);
		} finally {
			stopTopicBackfiller();
			vi.useRealTimers();
		}
	});
});
