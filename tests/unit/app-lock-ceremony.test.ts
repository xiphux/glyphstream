/**
 * The app-lock ceremony's pre-prompt steps fail on the network most often
 * right after a backgrounded app resumes — the moment it runs. They must come
 * back as a showable error, never as a rejection: the unlock screen calls this
 * from `onMount` with nothing above it to catch one.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getAppLockAssertion } from '$lib/app-lock-ceremony';

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('getAppLockAssertion', () => {
	it('turns a network failure into an error result instead of rejecting', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(() => Promise.reject(new TypeError('Load failed'))),
		);
		const result = await getAppLockAssertion();
		expect(result.ok).toBe(false);
		expect(!result.ok && result.error).toMatch(/connection/);
	});

	it('bounds the options request with a timeout signal', async () => {
		const fetchMock = vi.fn((_url: string, init?: RequestInit) => {
			expect(init?.signal).toBeInstanceOf(AbortSignal);
			return Promise.resolve(new Response('{"message":"nope"}', { status: 409 }));
		});
		vi.stubGlobal('fetch', fetchMock);
		const result = await getAppLockAssertion();
		expect(fetchMock).toHaveBeenCalledOnce();
		expect(result.ok).toBe(false);
	});
});
