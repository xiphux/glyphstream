import { SvelteMap } from 'svelte/reactivity';
import type { GalleryLayout, GalleryUnit, GalleryUnitsPage } from '#lib/types/api.js';
import type { LightboxSlide } from '#lib/media-variants.js';

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
	/** The last disagreement `onStale` was raised for — the seeded layout's
	 *  total and the page's — so a server that keeps giving the same two can't
	 *  drive a reseed loop, while a different one (another filter, a later
	 *  change) is still reported. */
	#staleSeen: { layout: number; page: number } | null = null;

	/** Fetch one page of units — injected so the loader is transport-agnostic
	 *  (and unit-testable). Returns the slice at `[offset, offset+limit)`. */
	#fetchPage: (offset: number, limit: number) => Promise<GalleryUnitsPage>;
	#onError?: (message: string) => void;
	/** Raised when a demand-loaded page reports a different total than the seeded
	 *  layout: the library changed underneath (a generation landed, a delete in
	 *  another tab), so every later offset is shifted and the caller should
	 *  reseed. Raised at most once per (layout total, page total) pair. */
	#onStale?: () => void;

	constructor(deps: {
		fetchPage: (offset: number, limit: number) => Promise<GalleryUnitsPage>;
		onError?: (message: string) => void;
		onStale?: () => void;
	}) {
		this.#fetchPage = deps.fetchPage;
		this.#onError = deps.onError;
		this.#onStale = deps.onStale;
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
			if (result.total !== this.totalUnits && !this.#sameStale(result.total)) {
				this.#staleSeen = { layout: this.totalUnits, page: result.total };
				this.#onStale?.();
			}
		} catch (e) {
			if (gen === this.#generation) {
				this.#failedPages.add(page);
				this.#onError?.(e instanceof Error ? e.message : 'Failed to load gallery');
			}
		} finally {
			if (gen === this.#generation) this.#loadingPages.delete(page);
		}
	}

	#sameStale(pageTotal: number): boolean {
		return this.#staleSeen?.layout === this.totalUnits && this.#staleSeen.page === pageTotal;
	}

	#absorb(offset: number, units: GalleryUnit[]): void {
		for (let i = 0; i < units.length; i++) this.#units.set(offset + i, units[i]);
	}

	/** Key of the loaded unit a given leader id anchors, or undefined if that unit
	 *  isn't loaded. Lets the page turn "the lightbox showed this media" into the
	 *  unit to patch, without exposing the index map. */
	unitKeyForLeader(leaderId: string): string | undefined {
		for (const u of this.#units.values()) if (u.leaderId === leaderId) return u.key;
		return undefined;
	}

	/**
	 * Adjust one loaded unit's `favoriteCount` in place, so a star toggled in the
	 * lightbox shows on its grid tile immediately.
	 *
	 * A local patch rather than a `seed()` from a fresh fetch because starring is
	 * the one action here a user repeats in bursts, and a reseed is two round trips
	 * (layout + units) to move one badge. The counts this patches are the only thing
	 * a star changes about a unit — membership, order, day buckets and previews are
	 * all untouched — so there is nothing else a refetch would fix. That property is
	 * also what lets the server keep serving its memoized unfiltered library across a
	 * star (`galleryUserFingerprint` validates the favorites half of its signature
	 * only for favorites-filtered entries), which means a reseed here would often
	 * return the very same units anyway.
	 *
	 * The caller knows which unit to name: a top-level tile's lightbox opens that
	 * unit's leader, and a drill-in already holds its unit. No-op for a key that
	 * isn't loaded (scrolled out of the sparse window) — it'll come back correct
	 * from the server.
	 *
	 * Filter caveat: this does NOT move a unit in or out of the grid, so with the
	 * Favorites filter active the page must still reseed — an unstar there changes
	 * what the library *contains*, not just how a tile is badged.
	 */
	patchUnitFavorite(unitKey: string, delta: number): void {
		for (const [index, u] of this.#units) {
			if (u.key !== unitKey) continue;
			this.#units.set(index, {
				...u,
				favoriteCount: Math.max(0, Math.min(u.memberCount, u.favoriteCount + delta)),
			});
			return;
		}
	}

	/** Loaded units' leader {id, kind} in newest-first index order — the sibling
	 *  set the top-level lightbox carousels over (spans only what's loaded).
	 *  Unique by id: pages fetched after the library shifted can hold a unit
	 *  twice until the reseed lands, and the lightbox keys its slides by id. */
	loadedLeaders(): LightboxSlide[] {
		const indices = [...this.#units.keys()].sort((a, b) => a - b);
		const seen = new Set<string>();
		const slides: LightboxSlide[] = [];
		for (const i of indices) {
			const u = this.#units.get(i)!;
			if (seen.has(u.leaderId)) continue;
			seen.add(u.leaderId);
			slides.push({
				id: u.leaderId,
				kind: u.leaderKind,
				width: u.leaderWidth,
				height: u.leaderHeight,
			});
		}
		return slides;
	}
}
