import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Fully mock the worker's collaborators so drain behavior is controllable — the
// point of these tests is the start/stop timer lifecycle, not the DB. A
// non-draining sweep is what exercises the re-arm branch where the generation
// guard actually matters (a draining sweep nulls the timer regardless of guard).
const chatMock = vi.hoisted(() => vi.fn());
vi.mock('$lib/server/endpoints/client', () => ({ chatCompletionSync: chatMock }));

const taskModelMock = vi.hoisted(() => vi.fn());
vi.mock('$lib/server/tasks/task-model', () => ({ getTaskModel: taskModelMock }));

const needingMock = vi.hoisted(() => vi.fn());
const setTopicMock = vi.hoisted(() => vi.fn());
vi.mock('$lib/server/db/queries/memories', () => ({
	listMemoriesNeedingTopic: needingMock,
	setMemoryTopic: setTopicMock,
}));

import { startTopicBackfiller, stopTopicBackfiller } from '$lib/server/memory/topic-backfill';

const MODEL = { endpoint: {}, upstreamId: 'm' };
const ROW = [{ id: 'm1', content: 'note' }];

/** Hold the model call open so a sweep can be caught mid-flight; returns a
 *  finisher that completes it. */
function deferChat(): (content: string) => void {
	let resolve!: (v: unknown) => void;
	chatMock.mockImplementation(() => new Promise((res) => (resolve = res)));
	return (content: string) => resolve({ choices: [{ message: { content } }] });
}

beforeEach(() => {
	chatMock.mockReset();
	taskModelMock.mockReset();
	needingMock.mockReset();
	setTopicMock.mockReset();
	taskModelMock.mockReturnValue(MODEL);
});

afterEach(() => {
	stopTopicBackfiller();
	vi.useRealTimers();
});

describe('topic backfiller timer lifecycle', () => {
	it('does not mount a timer when no task model is configured', () => {
		vi.useFakeTimers();
		taskModelMock.mockReturnValue(null);
		startTopicBackfiller();
		expect(vi.getTimerCount()).toBe(0);
	});

	it('self-stops after the queue drains', async () => {
		vi.useFakeTimers();
		needingMock.mockReturnValueOnce(ROW).mockReturnValue([]); // one batch, then empty
		setTopicMock.mockReturnValue(true);
		chatMock.mockResolvedValue({ choices: [{ message: { content: 'Topic' } }] });

		startTopicBackfiller();
		await vi.runOnlyPendingTimersAsync();
		await vi.advanceTimersByTimeAsync(0);
		expect(vi.getTimerCount()).toBe(0); // drained → no re-arm
	});

	it('re-arms after a non-draining sweep (baseline: the timer IS normally rescheduled)', async () => {
		vi.useFakeTimers();
		needingMock.mockReturnValue(ROW); // queue never empties
		setTopicMock.mockReturnValue(false); // no progress → sweep ends NON-drained
		chatMock.mockResolvedValue({ choices: [{ message: { content: 'Topic' } }] });

		startTopicBackfiller();
		await vi.runOnlyPendingTimersAsync();
		await vi.advanceTimersByTimeAsync(0);
		// The un-stopped worker reschedules — so the guard tests below are asserting
		// suppression of a re-arm that otherwise really happens (not a no-op path).
		expect(vi.getTimerCount()).toBe(1);
	});

	it('stop() during a non-draining sweep suppresses the re-arm', async () => {
		vi.useFakeTimers();
		needingMock.mockReturnValue(ROW);
		setTopicMock.mockReturnValue(false); // sweep completes NON-drained
		const finishChat = deferChat();

		startTopicBackfiller();
		await vi.runOnlyPendingTimersAsync(); // sweep in flight, blocked on the model
		expect(chatMock).toHaveBeenCalledTimes(1);
		expect(vi.getTimerCount()).toBe(0); // nothing armed mid-sweep

		stopTopicBackfiller();
		finishChat('Topic');
		await vi.advanceTimersByTimeAsync(0); // sweep finishes → re-arm branch runs

		// Delete the generation guard and this is 1 (the baseline test above proves
		// the re-arm path is live).
		expect(vi.getTimerCount()).toBe(0);
	});

	it('stop() then start() mid non-draining sweep leaves exactly the restart timer', async () => {
		vi.useFakeTimers();
		needingMock.mockReturnValue(ROW);
		setTopicMock.mockReturnValue(false);
		const finishChat = deferChat();

		startTopicBackfiller();
		await vi.runOnlyPendingTimersAsync(); // sweep #1 in flight
		stopTopicBackfiller();
		startTopicBackfiller(); // restart while sweep #1 is still in flight
		expect(vi.getTimerCount()).toBe(1); // exactly the restart's timer

		// Sweep #1 completes non-drained. Without the guard its re-arm branch would
		// add a SECOND timer (count 2); the generation token makes it a no-op.
		finishChat('Topic');
		await vi.advanceTimersByTimeAsync(0);
		expect(vi.getTimerCount()).toBe(1);
	});
});
