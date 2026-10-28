/**
 * The chat page's check-in state: reading a just-streamed reply, cancelling,
 * and the wake-up that reloads the page once a check-in is due.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const refreshAll = vi.fn(async () => {});
vi.mock('$app/navigation', () => ({ refreshAll: () => refreshAll() }));

import { CheckInController } from '#lib/check-in-controller.svelte.js';
import type { ChatMessage, PendingCheckIn } from '#lib/types/api.js';

function say(id: string, role: ChatMessage['role'], text: string, createdAt = 0): ChatMessage {
	return {
		id,
		role,
		parts: [{ type: 'text', text }],
		contentHtml: null,
		reasoningText: null,
		finishReason: null,
		modelUsed: null,
		tokensIn: null,
		tokensOut: null,
		genMs: null,
		createdAt,
	};
}

const PENDING: PendingCheckIn = { sourceMessageId: 'a', fireAt: 10_000, note: 'ask', createdAt: 0 };

beforeEach(() => refreshAll.mockClear());
afterEach(() => {
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

describe('noteReply', () => {
	it('takes the check-in a reply sets, from when it was written', () => {
		const c = new CheckInController({ convId: () => 'c1' }, null);
		const msgs = [say('u', 'user', 'hi'), say('a', 'assistant', 'brb\n\n[later 1h: ask]', 500)];
		c.noteReply(msgs, 'a');
		expect(c.pending).toEqual({
			sourceMessageId: 'a',
			fireAt: 500 + 3_600_000,
			note: 'ask',
			createdAt: 500,
		});
	});

	it('clears it for a reply that sets none', () => {
		const c = new CheckInController({ convId: () => 'c1' }, PENDING);
		c.noteReply([say('b', 'assistant', 'ok')], 'b');
		expect(c.pending).toBeNull();
	});

	it("leaves it for a reply that isn't loaded yet", () => {
		const c = new CheckInController({ convId: () => 'c1' }, PENDING);
		c.noteReply([], 'b');
		expect(c.pending).toBe(PENDING);
	});
});

describe('syncFromServer', () => {
	it('keeps the object it has for an unchanged row, so the wake-up keeps its timer', () => {
		const c = new CheckInController({ convId: () => 'c1' }, PENDING);
		c.syncFromServer({ ...PENDING });
		expect(c.pending).toBe(PENDING);
	});

	it('takes a row that changed', () => {
		const c = new CheckInController({ convId: () => 'c1' }, PENDING);
		const later = { ...PENDING, fireAt: PENDING.fireAt + 1 };
		c.syncFromServer(later);
		expect(c.pending).toBe(later);
		c.syncFromServer(null);
		expect(c.pending).toBeNull();
	});
});

describe('cancel', () => {
	it('deletes it on the server', async () => {
		const fetchMock = vi.fn(async () => Response.json({ cancelled: true }));
		vi.stubGlobal('fetch', fetchMock);
		const c = new CheckInController({ convId: () => 'c1' }, PENDING);
		await c.cancel();
		expect(c.pending).toBeNull();
		expect(fetchMock).toHaveBeenCalledWith('/api/conversations/c1/check-in', { method: 'DELETE' });
	});

	it('puts it back when the server refuses', async () => {
		vi.stubGlobal('fetch', async () => Response.json({ message: 'nope' }, { status: 500 }));
		const c = new CheckInController({ convId: () => 'c1' }, PENDING);
		await expect(c.cancel()).rejects.toThrow('nope');
		expect(c.pending).toBe(PENDING);
	});
});

describe('wakeWhenDue', () => {
	/** The probe answers with `status()`, read on each call. */
	function probe(status: () => object) {
		const fetchMock = vi.fn(async () => Response.json(status()));
		vi.stubGlobal('fetch', fetchMock);
		return fetchMock;
	}

	it('probes once due, and reloads only when the check-in has fired', async () => {
		vi.useFakeTimers();
		vi.setSystemTime(0);
		let status: object = { checkIn: PENDING };
		const fetchMock = probe(() => status);
		const c = new CheckInController({ convId: () => 'c1' }, PENDING);
		const stop = c.wakeWhenDue(PENDING, 0);
		await vi.advanceTimersByTimeAsync(10_000);
		expect(fetchMock).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(5_000);
		expect(fetchMock).toHaveBeenCalledWith('/api/conversations/c1/check-in');
		expect(refreshAll).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(30_000);
		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(refreshAll).not.toHaveBeenCalled();
		// Fired: the runner deleted the row as it started the turn.
		status = { checkIn: null };
		await vi.advanceTimersByTimeAsync(30_000);
		expect(refreshAll).toHaveBeenCalledOnce();
		stop();
	});

	it("doesn't take the server's due time differing from the page's guess as a change", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(0);
		// The page guessed from when the reply was written; the server set it
		// when the reply finished.
		probe(() => ({ checkIn: { ...PENDING, fireAt: PENDING.fireAt + 1_234 } }));
		const c = new CheckInController({ convId: () => 'c1' }, PENDING);
		const stop = c.wakeWhenDue(PENDING, 0);
		await vi.advanceTimersByTimeAsync(5 * 60_000);
		expect(refreshAll).not.toHaveBeenCalled();
		stop();
	});

	it('probes on after a reload', async () => {
		vi.useFakeTimers();
		vi.setSystemTime(0);
		// A reload that brings the same row back leaves this wake-up in place
		// (the page keeps the object: see syncFromServer), so the chain itself
		// must go on.
		const fetchMock = probe(() => ({ checkIn: { ...PENDING, sourceMessageId: 'other' } }));
		const c = new CheckInController({ convId: () => 'c1' }, PENDING);
		const stop = c.wakeWhenDue(PENDING, 0);
		await vi.advanceTimersByTimeAsync(15_000);
		expect(refreshAll).toHaveBeenCalledOnce();
		await vi.advanceTimersByTimeAsync(30_000);
		expect(fetchMock).toHaveBeenCalledTimes(2);
		stop();
	});

	it('probes on through failures without reloading, then catches the fire', async () => {
		vi.useFakeTimers();
		vi.setSystemTime(0);
		let fail = true;
		const fetchMock = vi.fn(async () =>
			fail ? new Response('', { status: 500 }) : Response.json({ checkIn: null }),
		);
		vi.stubGlobal('fetch', fetchMock);
		const c = new CheckInController({ convId: () => 'c1' }, PENDING);
		const stop = c.wakeWhenDue(PENDING, 0);
		await vi.advanceTimersByTimeAsync(15_000 + 2 * 30_000);
		expect(fetchMock).toHaveBeenCalledTimes(3);
		expect(refreshAll).not.toHaveBeenCalled();
		fail = false;
		await vi.advanceTimersByTimeAsync(30_000);
		expect(refreshAll).toHaveBeenCalledOnce();
		stop();
	});

	it("doesn't start the next probe until a slow reload has finished", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(0);
		let finish: () => void = () => {};
		refreshAll.mockImplementationOnce(() => new Promise<void>((r) => (finish = r)));
		const fetchMock = probe(() => ({ checkIn: null }));
		const c = new CheckInController({ convId: () => 'c1' }, PENDING);
		const stop = c.wakeWhenDue(PENDING, 0);
		await vi.advanceTimersByTimeAsync(15_000 + 90_000);
		expect(fetchMock).toHaveBeenCalledOnce();
		finish();
		await vi.advanceTimersByTimeAsync(30_000);
		expect(fetchMock).toHaveBeenCalledTimes(2);
		stop();
	});

	it('stops once the check-in is past its grace period, with one last reload', async () => {
		vi.useFakeTimers();
		vi.setSystemTime(0);
		const fetchMock = probe(() => ({ checkIn: PENDING }));
		const c = new CheckInController({ convId: () => 'c1' }, PENDING);
		c.wakeWhenDue(PENDING, 0);
		// Grace for a 10s delay is the 30-minute floor.
		await vi.advanceTimersByTimeAsync(PENDING.fireAt + 30 * 60_000 + 60_000);
		expect(refreshAll).toHaveBeenCalledOnce();
		const probes = fetchMock.mock.calls.length;
		await vi.advanceTimersByTimeAsync(10 * 60_000);
		expect(fetchMock).toHaveBeenCalledTimes(probes);
		expect(refreshAll).toHaveBeenCalledOnce();
	});

	it('does nothing more once cleaned up', async () => {
		vi.useFakeTimers();
		vi.setSystemTime(0);
		const fetchMock = probe(() => ({ checkIn: PENDING }));
		const c = new CheckInController({ convId: () => 'c1' }, PENDING);
		const stop = c.wakeWhenDue(PENDING, 0);
		await vi.advanceTimersByTimeAsync(15_000);
		stop();
		await vi.advanceTimersByTimeAsync(5 * 60_000);
		expect(fetchMock).toHaveBeenCalledOnce();
	});
});
