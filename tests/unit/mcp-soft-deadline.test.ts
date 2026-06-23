import { afterEach, describe, expect, it, vi } from 'vitest';

import { withSoftDeadline } from '$lib/server/mcp/registry';

// withSoftDeadline backs the message-send path's bounded MCP connect: a connect
// that overruns the budget must stop blocking the turn (resolve at the deadline)
// while still letting a healthy connect resolve early — and it must never reject,
// or one slow/dead server would surface as an unhandled rejection / thrown send.

afterEach(() => {
	vi.useRealTimers();
});

describe('withSoftDeadline', () => {
	it('resolves as soon as the inner promise settles, before the deadline', async () => {
		await expect(withSoftDeadline(Promise.resolve('ok'), 10_000)).resolves.toBeUndefined();
	});

	it('resolves at the deadline when the inner promise hangs, and never rejects', async () => {
		vi.useFakeTimers();
		let settled = false;
		const hang = new Promise(() => {}); // never settles — a stuck handshake
		void withSoftDeadline(hang, 2500).then(() => {
			settled = true;
		});

		await vi.advanceTimersByTimeAsync(2499);
		expect(settled).toBe(false); // still within budget — turn keeps waiting

		await vi.advanceTimersByTimeAsync(1);
		expect(settled).toBe(true); // budget elapsed — turn proceeds, connect runs on in bg
	});

	it('resolves (never rejects) when the inner promise rejects', async () => {
		// A failed connect rejects; the soft deadline swallows it so the send
		// path proceeds rather than throwing on a dead server.
		await expect(
			withSoftDeadline(Promise.reject(new Error('connect failed')), 10_000),
		).resolves.toBeUndefined();
	});
});
