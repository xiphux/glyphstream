/**
 * Unit tests for the installed app's half of the app lock, lifted out of the
 * (app) layout.
 *
 * The rules under test are the ones its docblock states: fail closed, one check
 * at a time, only the current check may act on its answer, a hide aborts a
 * check in flight, and a lapsed lock goes to /unlock carrying where the user
 * was headed. Runs the real runes; Kit's navigation modules and `fetch` are
 * stubbed, and `document.visibilityState` is a plain global.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const nav = vi.hoisted(() => ({
	goto: vi.fn(async (_url: string, _opts?: unknown) => {}),
	refreshAll: vi.fn(async () => {}),
	to: null as { url: URL } | null,
}));
vi.mock('$app/navigation', () => ({ goto: nav.goto, refreshAll: nav.refreshAll }));
vi.mock('$app/state', () => ({
	navigating: {
		get to() {
			return nav.to;
		},
	},
}));
vi.mock('$app/paths', () => ({ resolve: (p: string) => `/${p}` }));

import { AppLockGuard } from '#lib/app-lock-guard.svelte.js';
import { APP_LOCK_KEEPALIVE_PATH, APP_LOCKED_STATUS } from '#lib/app-lock.js';

let visibility: DocumentVisibilityState;

/** A fetch whose responses the test releases by hand, in any order. */
function deferredFetch() {
	const calls: Array<{ signal: AbortSignal; respond: (status: number) => void }> = [];
	const mock = vi.fn(
		(_url: string, init: RequestInit) =>
			new Promise<Response>((resolve, reject) => {
				const signal = init.signal!;
				signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
				calls.push({ signal, respond: (status) => resolve(new Response(null, { status })) });
			}),
	);
	vi.stubGlobal('fetch', mock);
	return { mock, calls };
}

const settle = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
	visibility = 'visible';
	vi.stubGlobal('document', {
		get visibilityState() {
			return visibility;
		},
	});
	vi.stubGlobal('location', new URL('http://x/chat/abc?q=1'));
	nav.to = null;
	nav.goto.mockClear();
	nav.refreshAll.mockClear();
});
afterEach(() => {
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

describe('AppLockGuard', () => {
	it('does nothing when the lock does not slide here', async () => {
		const { mock } = deferredFetch();
		const g = new AppLockGuard(() => false);
		g.cover();
		await g.check();
		expect(g.covered).toBe(false);
		expect(mock).not.toHaveBeenCalled();
	});

	it('uncovers when the server says the lock still holds', async () => {
		const { mock, calls } = deferredFetch();
		const g = new AppLockGuard(() => true);
		g.cover();
		const done = g.check();
		expect(mock).toHaveBeenCalledWith(APP_LOCK_KEEPALIVE_PATH, expect.anything());
		calls[0].respond(200);
		await done;
		expect(g.covered).toBe(false);
	});

	it('fails closed: an unreachable server leaves the cover up', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(() => Promise.reject(new TypeError('offline'))),
		);
		const g = new AppLockGuard(() => true);
		g.cover();
		await g.check();
		expect(g.covered).toBe(true);
	});

	it('runs one check at a time unless told to supersede', async () => {
		const { mock, calls } = deferredFetch();
		const g = new AppLockGuard(() => true);
		void g.check();
		void g.check();
		expect(mock).toHaveBeenCalledTimes(1);
		void g.check({ supersede: true });
		expect(mock).toHaveBeenCalledTimes(2);
		expect(calls[0].signal.aborted).toBe(true);
	});

	it('ignores an answer from a check that a hide cut off', async () => {
		const { calls } = deferredFetch();
		const g = new AppLockGuard(() => true);
		g.cover();
		const stale = g.check();
		// Going hidden aborts it; a 200 that predates the lapse must not uncover.
		g.cover();
		calls[0].respond(200);
		await stale;
		expect(g.covered).toBe(true);
	});

	it('cuts off a stalled check so later checks still run', async () => {
		vi.useFakeTimers();
		const { mock } = deferredFetch();
		const g = new AppLockGuard(() => true);
		const stalled = g.check();
		await vi.advanceTimersByTimeAsync(8_000);
		await stalled;
		void g.check();
		expect(mock).toHaveBeenCalledTimes(2);
	});

	it('skips the check while hidden', async () => {
		const { mock } = deferredFetch();
		visibility = 'hidden';
		await new AppLockGuard(() => true).check();
		expect(mock).not.toHaveBeenCalled();
	});

	it('sends a lapsed lock to /unlock with where the user was headed', async () => {
		const { calls } = deferredFetch();
		nav.to = { url: new URL('http://x/chat/tapped') };
		const g = new AppLockGuard(() => true);
		const done = g.check();
		calls[0].respond(APP_LOCKED_STATUS);
		await done;
		expect(nav.goto).toHaveBeenCalledWith(`/unlock?from=${encodeURIComponent('/chat/tapped')}`, {
			replace: true,
		});
	});

	it('does not hop again when already headed to /unlock', async () => {
		const { calls } = deferredFetch();
		nav.to = { url: new URL('http://x/unlock?from=%2F') };
		const g = new AppLockGuard(() => true);
		const done = g.check();
		calls[0].respond(APP_LOCKED_STATUS);
		await done;
		expect(nav.goto).not.toHaveBeenCalled();
	});

	it('hands a lost session to the layout load', async () => {
		const { calls } = deferredFetch();
		const g = new AppLockGuard(() => true);
		const done = g.check();
		calls[0].respond(401);
		await done;
		expect(nav.refreshAll).toHaveBeenCalled();
	});

	it('uncover drops the cover and any check in flight', async () => {
		const { calls } = deferredFetch();
		const g = new AppLockGuard(() => true);
		g.cover();
		const inFlight = g.check();
		g.uncover();
		expect(g.covered).toBe(false);
		expect(calls[0].signal.aborted).toBe(true);
		calls[0].respond(APP_LOCKED_STATUS);
		await inFlight;
		await settle();
		expect(nav.goto).not.toHaveBeenCalled();
	});
});
