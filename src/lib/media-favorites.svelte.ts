/**
 * The chat page's media stars: one source of truth for the fan-out grid's star
 * and the lightbox's, so starring in one shows in the other.
 *
 * The grid can't read stars off what it renders: a message part carries only
 * its `mediaId`. A grid rebuilt from server truth gets a seed per branch
 * (`ChatMessage.favorite`), and one fresh off the stream has nothing to seed,
 * which is correct, since nothing can have starred it yet. What either star
 * changes after that lives here, keyed by media id, and wins over the seed.
 *
 * One instance per chat page, never a module singleton: a write here is one
 * user's data, and a module-level store is shared by every request the server
 * renders (see CLAUDE.md on `#lib/*.svelte.ts` singletons).
 */
import { SvelteMap } from 'svelte/reactivity';
import { errorMessageFromResponse } from './fetch-error.js';
import { toast } from './toast.svelte.js';

export class MediaFavorites {
	/** Stars changed or observed this session, over the seed they came with. */
	readonly #known = new SvelteMap<string, boolean>();
	/** The media id whose star is in flight. One at a time, and every star
	 *  disables while it's set, so the disabled state says what the guard does
	 *  (the lightbox's `favoritingId` describes the same lock). */
	pendingId = $state<string | null>(null);

	/** Whether `mediaId` is starred, falling back to `seed` when nothing here
	 *  has seen it. */
	isFavorite(mediaId: string, seed = false): boolean {
		return this.#known.get(mediaId) ?? seed;
	}

	/** Record a star read from the server (the lightbox's per-item fetch), so the
	 *  grid follows a change made elsewhere. A star in flight keeps its
	 *  optimistic value: the read may predate the write. */
	observe(mediaId: string, favorite: boolean): void {
		if (this.pendingId === mediaId) return;
		this.#known.set(mediaId, favorite);
	}

	/** Star or unstar, optimistically. Resolves true when the server took it;
	 *  on failure the star flips back and a toast says why. */
	async toggle(mediaId: string, next: boolean): Promise<boolean> {
		if (this.pendingId) return false;
		this.pendingId = mediaId;
		const before = this.#known.get(mediaId);
		this.#known.set(mediaId, next);
		try {
			const res = await fetch(`/api/media/${mediaId}`, {
				method: 'PATCH',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ favorite: next }),
			});
			if (!res.ok) throw new Error(await errorMessageFromResponse(res));
			return true;
		} catch (e) {
			if (before === undefined) this.#known.delete(mediaId);
			else this.#known.set(mediaId, before);
			toast.error(`Couldn't update favorite: ${e instanceof Error ? e.message : String(e)}`);
			return false;
		} finally {
			this.pendingId = null;
		}
	}

	/** Forget everything, on a conversation switch: what was seen belongs to the
	 *  page as it was, and the next grid brings its own seeds. */
	clear(): void {
		this.#known.clear();
	}
}
