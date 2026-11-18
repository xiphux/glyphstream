/* @vitest-environment happy-dom */
/**
 * Watching developing photos for a page with no stream to tell it they landed
 * (`watchDevelopingPhotos`): it asks the server for those replies' photo state,
 * and hands it over once the count of draws out differs from the page's.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { watchDevelopingPhotos } from '#lib/photo-develop-watch.js';

let developing = 2;
const fetchMock = vi.fn(async () => Response.json({ developing, replies: {} }));
const apply = vi.fn();

function watch() {
	return watchDevelopingPhotos({
		conversationId: 'c1',
		replyIds: ['r1', 'r2'],
		expected: 2,
		apply,
	});
}

beforeEach(() => {
	vi.useFakeTimers();
	vi.stubGlobal('fetch', fetchMock);
	developing = 2;
	fetchMock.mockClear();
	apply.mockClear();
});
afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe('watchDevelopingPhotos', () => {
	it('asks after the replies on screen, and leaves the page be while they draw', async () => {
		const stop = watch();
		await vi.advanceTimersByTimeAsync(5_000);
		expect(fetchMock).toHaveBeenCalledWith('/api/conversations/c1/photos?messages=r1,r2', {
			signal: expect.any(AbortSignal) as unknown,
		});
		expect(apply).not.toHaveBeenCalled();
		stop();
	});

	it('hands over the state when one has landed, or another has started', async () => {
		const stop = watch();
		developing = 1;
		await vi.advanceTimersByTimeAsync(5_000);
		expect(apply).toHaveBeenLastCalledWith({ developing: 1, replies: {} });
		developing = 3;
		await vi.advanceTimersByTimeAsync(5_000);
		expect(apply).toHaveBeenLastCalledWith({ developing: 3, replies: {} });
		stop();
	});

	it('asks at once when the app comes back, rather than at the next tick', async () => {
		const stop = watch();
		developing = 0;
		// happy-dom drops `persisted` from the init dict, so set it on the event.
		window.dispatchEvent(Object.assign(new Event('pageshow'), { persisted: true }));
		await vi.advanceTimersByTimeAsync(0);
		expect(apply).toHaveBeenCalledOnce();
		stop();
	});

	it('gives up on a request that never answers, so the next tick asks again', async () => {
		const timeouts: AbortController[] = [];
		vi.spyOn(AbortSignal, 'timeout').mockImplementation(() => {
			const c = new AbortController();
			timeouts.push(c);
			return c.signal;
		});
		const hanging = vi.fn(
			(_url: string, init?: RequestInit) =>
				new Promise<Response>((_resolve, reject) => {
					init?.signal?.addEventListener('abort', () => reject(new Error('timed out')));
				}),
		);
		vi.stubGlobal('fetch', hanging);
		const stop = watch();
		await vi.advanceTimersByTimeAsync(5_000);
		expect(hanging).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(5_000);
		expect(hanging).toHaveBeenCalledTimes(1);

		timeouts[0].abort();
		await vi.advanceTimersByTimeAsync(5_000);
		expect(hanging).toHaveBeenCalledTimes(2);
		stop();
	});

	it('stops asking once stopped', async () => {
		watch()();
		await vi.advanceTimersByTimeAsync(20_000);
		expect(fetchMock).not.toHaveBeenCalled();
	});
});
