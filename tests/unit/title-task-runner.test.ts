/**
 * The title-task-runner sits between the streaming relays and the
 * title generator. It owns two pieces of orchestration whose subtle
 * behavior matters:
 *
 *   - startTitleTaskIfFirstExchange: the "fire only on the first
 *     exchange" gate. Without it, every assistant turn would re-run
 *     the title model — wasted tokens AND a risk of stomping a
 *     user-set title (the conditional UPDATE downstream defends
 *     against the second, but we shouldn't make it work harder).
 *
 *   - raceTitle: bounded wait that resolves to null on timeout without
 *     blocking the SSE response indefinitely. The underlying task
 *     keeps running after the timeout — the caller is just no longer
 *     waiting.
 *
 * Both helpers swallow errors and never reject. That's a stronger
 * contract than "it usually works"; pin it down.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
	getTaskModel: vi.fn<() => { endpoint: unknown; upstreamId: string } | null>(),
	isTaskModelPrivate: vi.fn<() => boolean>(),
	getConversationTitleSource:
		vi.fn<(id: string, userId: string) => 'fallback' | 'ai' | 'user' | null>(),
	getConversationMeta: vi.fn<(id: string, userId: string) => { private: boolean } | null>(),
	generateConversationTitle:
		vi.fn<(id: string, userId: string) => Promise<{ title: string; persisted: boolean } | null>>(),
}));

vi.mock('$lib/server/tasks/task-model', () => ({
	getTaskModel: mocks.getTaskModel,
	isTaskModelPrivate: mocks.isTaskModelPrivate,
}));

vi.mock('$lib/server/db/queries/conversations', () => ({
	getConversationTitleSource: mocks.getConversationTitleSource,
	getConversationMeta: mocks.getConversationMeta,
}));

vi.mock('$lib/server/tasks/title-generator', () => ({
	generateConversationTitle: mocks.generateConversationTitle,
}));

import { raceTitle, startTitleTaskIfFirstExchange } from '$lib/server/tasks/title-task-runner';

beforeEach(() => {
	mocks.getTaskModel.mockReset();
	mocks.isTaskModelPrivate.mockReset();
	mocks.getConversationTitleSource.mockReset();
	mocks.getConversationMeta.mockReset();
	mocks.generateConversationTitle.mockReset();
	// Safe defaults: task model not trusted-for-private, conversation not private —
	// so the private gate is a no-op unless a test opts in.
	mocks.isTaskModelPrivate.mockReturnValue(false);
	mocks.getConversationMeta.mockReturnValue({ private: false });
});

describe('startTitleTaskIfFirstExchange — gating', () => {
	it('resolves to null without calling the generator when no task model is configured', async () => {
		mocks.getTaskModel.mockReturnValue(null);
		const result = await startTitleTaskIfFirstExchange('c1', 'u1');
		expect(result).toBeNull();
		expect(mocks.generateConversationTitle).not.toHaveBeenCalled();
		// Don't even peek at title_source if there's no task model — saves
		// a DB read on every assistant turn after the first exchange.
		expect(mocks.getConversationTitleSource).not.toHaveBeenCalled();
	});

	it('skips when title_source is already "ai" (subsequent assistant turns)', async () => {
		mocks.getTaskModel.mockReturnValue({ endpoint: {}, upstreamId: 'qwen2.5:0.5b' });
		mocks.getConversationTitleSource.mockReturnValue('ai');
		const result = await startTitleTaskIfFirstExchange('c1', 'u1');
		expect(result).toBeNull();
		expect(mocks.generateConversationTitle).not.toHaveBeenCalled();
	});

	it('skips when title_source is "user" (manual rename locks the title)', async () => {
		mocks.getTaskModel.mockReturnValue({ endpoint: {}, upstreamId: 'qwen2.5:0.5b' });
		mocks.getConversationTitleSource.mockReturnValue('user');
		const result = await startTitleTaskIfFirstExchange('c1', 'u1');
		expect(result).toBeNull();
		expect(mocks.generateConversationTitle).not.toHaveBeenCalled();
	});

	it('runs the generator when source is "fallback" (the only run case)', async () => {
		mocks.getTaskModel.mockReturnValue({ endpoint: {}, upstreamId: 'qwen2.5:0.5b' });
		mocks.getConversationTitleSource.mockReturnValue('fallback');
		mocks.generateConversationTitle.mockResolvedValue({ title: 'A Title', persisted: true });
		const result = await startTitleTaskIfFirstExchange('c1', 'u1');
		expect(result).toBe('A Title');
		expect(mocks.generateConversationTitle).toHaveBeenCalledWith('c1', 'u1');
	});
});

describe('startTitleTaskIfFirstExchange — private-chat seal', () => {
	beforeEach(() => {
		mocks.getTaskModel.mockReturnValue({ endpoint: {}, upstreamId: 'qwen2.5:0.5b' });
		mocks.getConversationTitleSource.mockReturnValue('fallback');
		mocks.generateConversationTitle.mockResolvedValue({ title: 'A Title', persisted: true });
	});

	it('skips titling a private chat when the task model is not trusted-for-private', async () => {
		mocks.isTaskModelPrivate.mockReturnValue(false);
		mocks.getConversationMeta.mockReturnValue({ private: true });
		const result = await startTitleTaskIfFirstExchange('c1', 'u1');
		expect(result).toBeNull();
		// Content never reaches the task model — the generator isn't called.
		expect(mocks.generateConversationTitle).not.toHaveBeenCalled();
	});

	it('titles a private chat when the task model IS trusted-for-private', async () => {
		mocks.isTaskModelPrivate.mockReturnValue(true);
		mocks.getConversationMeta.mockReturnValue({ private: true });
		const result = await startTitleTaskIfFirstExchange('c1', 'u1');
		expect(result).toBe('A Title');
		expect(mocks.generateConversationTitle).toHaveBeenCalledWith('c1', 'u1');
		// Short-circuits on the config flag → no per-call DB read for `private`.
		expect(mocks.getConversationMeta).not.toHaveBeenCalled();
	});

	it('titles a non-private chat normally (untrusted task model is irrelevant)', async () => {
		mocks.isTaskModelPrivate.mockReturnValue(false);
		mocks.getConversationMeta.mockReturnValue({ private: false });
		expect(await startTitleTaskIfFirstExchange('c1', 'u1')).toBe('A Title');
		expect(mocks.generateConversationTitle).toHaveBeenCalledWith('c1', 'u1');
	});
});

describe('startTitleTaskIfFirstExchange — result shaping', () => {
	beforeEach(() => {
		mocks.getTaskModel.mockReturnValue({ endpoint: {}, upstreamId: 'qwen2.5:0.5b' });
		mocks.getConversationTitleSource.mockReturnValue('fallback');
	});

	it('returns the title when the conditional UPDATE persisted', async () => {
		mocks.generateConversationTitle.mockResolvedValue({ title: 'Generated', persisted: true });
		expect(await startTitleTaskIfFirstExchange('c1', 'u1')).toBe('Generated');
	});

	it('returns null when the title was generated but lost to a user rename race', async () => {
		// A user manually renamed between when the task model started and
		// when it finished. The title exists but didn't land in the DB — we
		// don't want to surface a "fresh title" to the client that the DB
		// doesn't actually carry, so resolve to null.
		mocks.generateConversationTitle.mockResolvedValue({
			title: 'Stale',
			persisted: false,
		});
		expect(await startTitleTaskIfFirstExchange('c1', 'u1')).toBeNull();
	});

	it('returns null when the generator returned null (no exchange / empty)', async () => {
		mocks.generateConversationTitle.mockResolvedValue(null);
		expect(await startTitleTaskIfFirstExchange('c1', 'u1')).toBeNull();
	});

	it('returns null instead of throwing when the generator rejects', async () => {
		// Title gen failures must NEVER reject — the caller is the relay's
		// fire-and-forget chain, and a reject would surface as an unhandled
		// rejection that prints in the server logs every time the upstream
		// task model is slow.
		mocks.generateConversationTitle.mockRejectedValue(new Error('task model died'));
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		try {
			expect(await startTitleTaskIfFirstExchange('c1', 'u1')).toBeNull();
			expect(warn).toHaveBeenCalled();
		} finally {
			warn.mockRestore();
		}
	});
});

describe('raceTitle', () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it('resolves to the value when the promise wins', async () => {
		const slow = Promise.resolve('done');
		const out = await raceTitle(slow, 5_000);
		expect(out).toBe('done');
	});

	it('resolves to null when the timeout wins', async () => {
		const never = new Promise<string | null>(() => {}); // never settles
		const racePromise = raceTitle(never, 1_000);
		vi.advanceTimersByTime(1_001);
		await expect(racePromise).resolves.toBeNull();
	});

	it('resolves to null when the underlying promise rejects (errors are swallowed)', async () => {
		const failing = Promise.reject(new Error('upstream said no'));
		// Awaiting consumes the rejection — no unhandledrejection escapes.
		await expect(raceTitle(failing, 5_000)).resolves.toBeNull();
	});

	it('does not double-resolve when the promise wins after the timeout already fired', async () => {
		let release!: (v: string | null) => void;
		const late = new Promise<string | null>((res) => {
			release = res;
		});
		const racePromise = raceTitle(late, 100);
		// Timeout wins first.
		vi.advanceTimersByTime(150);
		await expect(racePromise).resolves.toBeNull();
		// Now the underlying promise finally resolves — must NOT
		// re-resolve the race or surface an unhandled value anywhere.
		expect(() => release('arrived late')).not.toThrow();
	});

	it('cancels the timeout when the promise wins (no dangling timer)', async () => {
		const clearSpy = vi.spyOn(global, 'clearTimeout');
		try {
			await raceTitle(Promise.resolve('fast'), 5_000);
			expect(clearSpy).toHaveBeenCalled();
		} finally {
			clearSpy.mockRestore();
		}
	});
});
