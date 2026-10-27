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

const PENDING: PendingCheckIn = { sourceMessageId: 'a', fireAt: 10_000, note: 'ask' };

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
		expect(c.pending).toEqual({ sourceMessageId: 'a', fireAt: 500 + 3_600_000, note: 'ask' });
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
});
