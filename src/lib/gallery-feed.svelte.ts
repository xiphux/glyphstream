import { SvelteMap } from 'svelte/reactivity';
import type { GalleryLayout, GalleryUnit, GalleryUnitsPage } from '$lib/server/db/queries/media';

/**
 * Client-side demand loader for the virtualized gallery grid.
 *
 * The server owns the stacked layout (see `computeGalleryLayout` /
 * `listGalleryUnits`): the client reserves exact scroll height from the per-day
 * unit *counts* up front, then streams the thin `GalleryUnit` descriptors for
 * only the ranges near the viewport. This class holds that sparse, page-aligned
 * cache and the fetch bookkeeping; the page feeds it the visible global-index
 * range (derived from the scroll window) and reads units back by index,
 * rendering a placeholder tile wherever a unit hasn't landed yet.
 *
 * Page-aligned so ranges cache and dedupe cleanly: a unit at global index `i`
 * belongs to page `floor(i / PAGE)`, and a page is fetched at most once.
 */
export class GalleryFeed {
	/** Units per fetched page — also the initial-load seed size and the `?limit=`. */
	static readonly PAGE = 120;

	/** Per-day unit counts + total; sizes the whole grid. Null until seeded. */
	layout = $state<GalleryLayout | null>(null);
	/** Loaded units by absolute (newest-first) index. Reactive for the template. */
	#units = new SvelteMap<number, GalleryUnit>();
	/** Pages fully loaded / in flight, so a page is never fetched twice. */
	#loadedPages = new Set<number>();
	#loadingPages = new Set<number>();
	/** Pages whose fetch failed. Held so the scroll-driven demand loader doesn't
	 *  re-fire the request every frame while the user scrolls a broken range — the
	 *  page waits for a reseed (the error banner's Retry) to clear it. */
	#failedPages = new Set<number>();
	/** Bumped on every `seed()`; an in-flight fetch from a superseded filter/tz
	 *  checks this before writing, so a stale page can't land in the fresh cache. */
	#generation = 0;

	/** Fetch one page of units — injected so the loader is transport-agnostic
	 *  (and unit-testable). Returns the slice at `[offset, offset+limit)`. */
	#fetchPage: (offset: number, limit: number) => Promise<GalleryUnitsPage>;
	#onError?: (message: string) => void;

	constructor(deps: {
		fetchPage: (offset: number, limit: number) => Promise<GalleryUnitsPage>;
		onError?: (message: string) => void;
	}) {
		this.#fetchPage = deps.fetchPage;
		this.#onError = deps.onError;
	}

	get totalUnits(): number {
		return this.layout?.totalUnits ?? 0;
	}

	/** The unit at a global index, or undefined if its page hasn't loaded yet. */
	unitAt(index: number): GalleryUnit | undefined {
		return this.#units.get(index);
	}

	/**
	 * Seed from a fresh client fetch: the full layout plus the first page of units
	 * (offset 0). Browse is loaded on mount and on every filter/stacking change —
	 * never SSR'd — so this clears any prior cache to keep a stale filter's units
	 * from bleeding through.
	 */
	seed(layout: GalleryLayout, initialUnits: GalleryUnit[]): void {
		this.#generation++;
		this.layout = layout;
		this.#units.clear();
		this.#loadedPages.clear();
		this.#loadingPages.clear();
		this.#failedPages.clear();
		this.#absorb(0, initialUnits);
		// The initial units are the contiguous head [0, n); mark every fully
		// covered page loaded so we don't refetch page 0.
		const covered = Math.floor(initialUnits.length / GalleryFeed.PAGE);
		for (let p = 0; p < covered; p++) this.#loadedPages.add(p);
		// The head may end mid-page but still be complete if it reaches the total
		// (the last, short page).
		if (initialUnits.length >= this.totalUnits && this.totalUnits > 0) {
			this.#loadedPages.add(Math.floor((this.totalUnits - 1) / GalleryFeed.PAGE));
		} else if (initialUnits.length % GalleryFeed.PAGE === 0 && initialUnits.length > 0) {
			// exact page boundary already handled by `covered`
		}
	}

	/**
	 * Ensure every page covering the global index range `[start, end)` is loaded
	 * or loading. Cheap to call every scroll frame — already-loaded/in-flight
	 * pages are skipped.
	 */
	ensureRange(start: number, end: number): void {
		if (end <= start || this.totalUnits === 0) return;
		const clampedEnd = Math.min(end, this.totalUnits);
		const firstPage = Math.max(0, Math.floor(start / GalleryFeed.PAGE));
		const lastPage = Math.floor((clampedEnd - 1) / GalleryFeed.PAGE);
		for (let p = firstPage; p <= lastPage; p++) void this.#loadPage(p);
	}

	async #loadPage(page: number): Promise<void> {
		if (page < 0) return;
		const offset = page * GalleryFeed.PAGE;
		if (offset >= this.totalUnits) return;
		if (this.#loadedPages.has(page) || this.#loadingPages.has(page) || this.#failedPages.has(page))
			return;
		const gen = this.#generation;
		this.#loadingPages.add(page);
		try {
			const result = await this.#fetchPage(offset, GalleryFeed.PAGE);
			if (gen !== this.#generation) return; // superseded by a reseed — discard
			this.#absorb(offset, result.units);
			this.#loadedPages.add(page);
		} catch (e) {
			if (gen === this.#generation) {
				// Mark the page failed so the scroll-driven loader stops retrying it
				// every frame; a reseed (Retry) clears it for another attempt.
				this.#failedPages.add(page);
				this.#onError?.(e instanceof Error ? e.message : 'Failed to load gallery');
			}
		} finally {
			if (gen === this.#generation) this.#loadingPages.delete(page);
		}
	}

	#absorb(offset: number, units: GalleryUnit[]): void {
		for (let i = 0; i < units.length; i++) this.#units.set(offset + i, units[i]);
	}

	/** Loaded units' leader {id, kind} in newest-first index order — the sibling
	 *  set the top-level lightbox carousels over (spans only what's loaded). */
	loadedLeaders(): { id: string; kind: GalleryUnit['leaderKind'] }[] {
		const indices = [...this.#units.keys()].sort((a, b) => a - b);
		return indices.map((i) => {
			const u = this.#units.get(i)!;
			return { id: u.leaderId, kind: u.leaderKind };
		});
	}
}
