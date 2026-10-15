import { describe, expect, it, vi } from 'vitest';
import { MediaItemCache } from '#lib/media-item-cache.js';
import type { MediaListItem } from '#lib/types/api.js';

const item = (id: string, extra: Partial<MediaListItem> = {}) =>
	({ id, favorite: false, ...extra }) as MediaListItem;

describe('MediaItemCache', () => {
	it('fetches once and serves the row from memory after', async () => {
		const fetchItem = vi.fn((id: string) => Promise.resolve(item(id)));
		const cache = new MediaItemCache(fetchItem);
		expect(cache.peek('a')).toBeUndefined();
		await cache.load('a');
		expect(cache.peek('a')?.id).toBe('a');
		await cache.load('a');
		expect(fetchItem).toHaveBeenCalledTimes(1);
	});

	it('shares a fetch already in flight, so a swipe onto a prefetching slide waits on it', async () => {
		const fetchItem = vi.fn((id: string) => Promise.resolve(item(id)));
		const cache = new MediaItemCache(fetchItem);
		cache.prefetch('a');
		await cache.load('a');
		expect(fetchItem).toHaveBeenCalledTimes(1);
	});

	it('swallows a failed prefetch and fetches again on the next load', async () => {
		const fetchItem = vi
			.fn<(id: string) => Promise<MediaListItem>>()
			.mockRejectedValueOnce(new Error('offline'))
			.mockImplementation((id) => Promise.resolve(item(id)));
		const cache = new MediaItemCache(fetchItem);
		cache.prefetch('a');
		await new Promise((r) => setTimeout(r, 0));
		expect(cache.peek('a')).toBeUndefined();
		await expect(cache.load('a')).resolves.toMatchObject({ id: 'a' });
		expect(fetchItem).toHaveBeenCalledTimes(2);
	});

	it('patches a cached row in place, and ignores a row it never fetched', async () => {
		const cache = new MediaItemCache((id) => Promise.resolve(item(id)));
		await cache.load('a');
		cache.patch('a', { favorite: true });
		cache.patch('b', { favorite: true });
		expect(cache.peek('a')?.favorite).toBe(true);
		expect(cache.peek('b')).toBeUndefined();
	});

	it("doesn't let a fetch from before a clear refill the cache", async () => {
		let release!: (m: MediaListItem) => void;
		const cache = new MediaItemCache(() => new Promise((r) => (release = r)));
		const pending = cache.load('a');
		cache.clear();
		release(item('a'));
		await pending;
		// The lightbox closed in between; the next open must fetch fresh.
		expect(cache.peek('a')).toBeUndefined();
	});
});
