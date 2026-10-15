/**
 * The full rows a lightbox carousel has fetched this open session, so swiping
 * to a slide can show its details at once instead of after a round trip.
 *
 * The carousel's `siblings` are just `{ id, kind }`. A slide's model, prompt and
 * favorite state come from `GET /api/media/:id`, and the lightbox swaps them in
 * at the swipe's midpoint. If that swap waits on the network, the header goes on
 * describing the slide the user left (a lit star over an unstarred image) for as
 * long as the fetch takes. MediaLightbox asks for the neighbours of the slide on
 * screen through `onPrefetch`, so a swipe usually lands on a row already here.
 *
 * One instance per open session, owned by whoever hosts the lightbox, and
 * cleared when it closes. That keeps staleness to what the lightbox itself
 * changes, and those writes go through `patch` / `delete`. Not a module
 * singleton: those are shared by every request during SSR (see CLAUDE.md).
 */
import type { MediaListItem } from './types/api.js';

export class MediaItemCache {
	#fetchItem: (id: string) => Promise<MediaListItem>;
	#items = new Map<string, MediaListItem>();
	#inflight = new Map<string, Promise<MediaListItem>>();
	/** Bumped by `clear`, so a fetch started before it can't refill the cache. */
	#generation = 0;

	constructor(fetchItem: (id: string) => Promise<MediaListItem>) {
		this.#fetchItem = fetchItem;
	}

	/** The row, if it's already here. */
	peek(id: string): MediaListItem | undefined {
		return this.#items.get(id);
	}

	/** The row, fetching it if needed. A fetch already in flight for the id,
	 *  a prefetch included, is shared rather than repeated. */
	load(id: string): Promise<MediaListItem> {
		const hit = this.#items.get(id);
		if (hit) return Promise.resolve(hit);
		const pending = this.#inflight.get(id);
		if (pending) return pending;
		const generation = this.#generation;
		const p = this.#fetchItem(id)
			.then((item) => {
				if (generation === this.#generation) this.#items.set(id, item);
				return item;
			})
			.finally(() => {
				if (this.#inflight.get(id) === p) this.#inflight.delete(id);
			});
		this.#inflight.set(id, p);
		return p;
	}

	/** Warm the cache for a slide the user may swipe to. A failure is dropped: the
	 *  swipe itself will fetch again and report it then. */
	prefetch(id: string): void {
		this.load(id).catch(() => {});
	}

	/** Keep a cached row in step with a change made to it, like a star toggle. */
	patch(id: string, fields: Partial<MediaListItem>): void {
		const hit = this.#items.get(id);
		if (hit) this.#items.set(id, { ...hit, ...fields });
	}

	delete(id: string): void {
		this.#items.delete(id);
	}

	clear(): void {
		this.#generation++;
		this.#items.clear();
		this.#inflight.clear();
	}
}
