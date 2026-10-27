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
	it('reloads once due, and again while it stays pending', () => {
		vi.useFakeTimers();
		vi.setSystemTime(0);
		const c = new CheckInController({ convId: () => 'c1' }, PENDING);
		const stop = c.wakeWhenDue(PENDING, 0);
		vi.advanceTimersByTime(10_000);
		expect(refreshAll).not.toHaveBeenCalled();
		vi.advanceTimersByTime(5_000);
		expect(refreshAll).toHaveBeenCalledOnce();
		vi.advanceTimersByTime(30_000);
		expect(refreshAll).toHaveBeenCalledTimes(2);
		stop();
		vi.advanceTimersByTime(60_000);
		expect(refreshAll).toHaveBeenCalledTimes(2);
	});

	it('stops once the check-in is past its grace period', () => {
		vi.useFakeTimers();
		vi.setSystemTime(0);
		const c = new CheckInController({ convId: () => 'c1' }, PENDING);
		c.wakeWhenDue(PENDING, 0);
		// Grace for a 10s delay is the 30-minute floor.
		vi.advanceTimersByTime(PENDING.fireAt + 30 * 60_000 + 60_000);
		const calls = refreshAll.mock.calls.length;
		vi.advanceTimersByTime(10 * 60_000);
		expect(refreshAll).toHaveBeenCalledTimes(calls);
	});
});
