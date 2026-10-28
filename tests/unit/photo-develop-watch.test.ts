/* @vitest-environment happy-dom */
/**
 * Watching developing photos for a page with no stream to tell it they landed
 * (`watchDevelopingPhotos`): it asks the server for a count, and reloads once
 * the count drops below what the page's data says is out.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { watchDevelopingPhotos } from '#lib/photo-develop-watch.js';

let developing = 2;
const fetchMock = vi.fn(async () => Response.json({ developing }));
const refresh = vi.fn(async () => {});

function watch() {
	return watchDevelopingPhotos({
		conversationId: 'c1',
		replyIds: ['r1', 'r2'],
		expected: 2,
		refresh,
	});
}

beforeEach(() => {
	vi.useFakeTimers();
	vi.stubGlobal('fetch', fetchMock);
	developing = 2;
	fetchMock.mockClear();
	refresh.mockClear();
});
afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

describe('watchDevelopingPhotos', () => {
	it('asks after the replies on screen, and leaves the page be while they draw', async () => {
		const stop = watch();
		await vi.advanceTimersByTimeAsync(5_000);
		expect(fetchMock).toHaveBeenCalledWith('/api/conversations/c1/photos?messages=r1,r2');
		expect(refresh).not.toHaveBeenCalled();
		stop();
	});

	it('reloads once, when one of them has landed', async () => {
		const stop = watch();
		developing = 1;
		await vi.advanceTimersByTimeAsync(5_000);
		await vi.advanceTimersByTimeAsync(10_000);
		expect(refresh).toHaveBeenCalledOnce();
		stop();
	});

	it('asks at once when the app comes back, rather than at the next tick', async () => {
		const stop = watch();
		developing = 0;
		// happy-dom drops `persisted` from the init dict, so set it on the event.
		window.dispatchEvent(Object.assign(new Event('pageshow'), { persisted: true }));
		await vi.advanceTimersByTimeAsync(0);
		expect(refresh).toHaveBeenCalledOnce();
		stop();
	});

	it('stops asking once stopped', async () => {
		watch()();
		await vi.advanceTimersByTimeAsync(20_000);
		expect(fetchMock).not.toHaveBeenCalled();
	});
});
