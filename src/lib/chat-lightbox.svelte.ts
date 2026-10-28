/**
 * The chat page's inline media lightbox: the open item, the carousel set it
 * swipes through, and its favorite and discard actions.
 *
 * Tapping a generated image used to open it in a new tab (target=_blank on the
 * wrapping anchor). That works on desktop but breaks in PWA standalone mode
 * where there's no tab strip to return through — users got stranded on a bare
 * image page with only a back-swipe gesture home. Reusing the gallery's
 * MediaLightbox keeps the tap inside the app and brings model/prompt/download
 * affordances along for free.
 *
 * MessagePart only carries `mediaId`; model + prompt + size live on the media
 * row. One fetch per tap (~100-200ms) populates the metadata. The fetch races
 * are guarded by the id-comparison pattern: a stale response from a previous
 * tap can't clobber the current state. Rows fetched while the lightbox is open
 * are kept (see MediaItemCache), and the lightbox prefetches the neighbours of
 * the slide on screen, so a swipe usually swaps its details in without waiting.
 *
 * Lifted out of the chat page, which hosts it; the MediaLightbox component
 * stays purely presentational.
 */
import { errorMessageFromResponse } from './fetch-error.js';
import {
	applyDisplayOrder,
	atActiveBranchCapacity,
	canDiscardColumn,
	columnMediaIds,
	columnShowingMedia,
	gridMediaIds,
	survivorInSlot,
} from './fanout.js';
import { MediaItemCache } from './media-item-cache.js';
import type { MediaFavorites } from './media-favorites.svelte.js';
import { toast } from './toast.svelte.js';
import type { FanoutColumn } from './fanout.js';
import type { ConversationMediaRef, MediaListItem } from './types/api.js';

/** Same limit as the gallery's `fetchWithTimeout`. */
const ITEM_FETCH_TIMEOUT_MS = 15_000;

/**
 * The comparison grid on screen, whose images the lightbox triages: the media
 * fan-out grid in the thread, or a photo comparison in the develop dialog. The
 * same columns and the same four reactions either way.
 */
export interface TriageSource {
	columns: readonly FanoutColumn[];
	/** Whether it's a media grid at all (a text fan-out has nothing to triage). */
	isMedia: boolean;
	/** A pick or discard is in flight. */
	picking: boolean;
	canRegenerate(col: FanoutColumn): boolean;
	regenerate(col: FanoutColumn): Promise<void>;
	pick(col: FanoutColumn): Promise<void>;
	/** False when refused; the reason is in the page's error banner. */
	discard(col: FanoutColumn): Promise<boolean>;
}

/** What the lightbox reads from the host page. Getters, so each read is fresh:
 *  the page is reused across conversations. */
export interface ChatLightboxDeps {
	/** The conversation currently on screen. */
	conversationId(): string;
	/** The grid being triaged right now. */
	triage(): TriageSource;
	/** The page's stars, shared with the fan-out grid's. */
	favorites: MediaFavorites;
	/** The page's error banner, which a refused fan-out discard writes to. */
	error(): string | null;
}

export class ChatLightbox {
	#deps: ChatLightboxDeps;

	/** The open item, or null when closed. */
	media = $state<MediaListItem | null>(null);
	/** The item whose details are being fetched; its bubble shows a spinner. */
	openingFor = $state<string | null>(null);

	/**
	 * Ordered set the lightbox swipes/arrows between: every image/video in the
	 * conversation, across ALL branches, oldest first — except the images of a
	 * fan-out grid that's open, which are re-seated into that grid's dispatch
	 * order (see #loadSiblings). Fetched (not derived from the visible messages)
	 * because multi-image batches, multi-model grids, and regenerate revisions are
	 * sibling branches — only one sits on the active leaf path, so the message
	 * list would surface just one image per generation point. `open` doubles as
	 * the resolver, fetching each swiped-to row's metadata.
	 *
	 * `.raw` — replaced wholesale, never mutated in place.
	 */
	siblings = $state.raw<ConversationMediaRef[]>([]);

	deletingId = $state<string | null>(null);

	/** Rows fetched this open session. Cleared on close and on reset.
	 *
	 *  Time-boxed because a fetch here is shared: a prefetch still hanging when
	 *  the user swipes onto its slide is the very promise that swipe waits on, so
	 *  without a limit the slide would never resolve and never get a retry. */
	readonly #items = new MediaItemCache(async (id) => {
		const res = await fetch(`/api/media/${id}`, {
			signal: AbortSignal.timeout(ITEM_FETCH_TIMEOUT_MS),
		});
		if (!res.ok) throw new Error(await errorMessageFromResponse(res));
		return (await res.json()) as MediaListItem;
	});

	/**
	 * The lightbox's Delete, offered only for an image the open media fan-out
	 * grid is showing, and only where that grid's own trash button would allow
	 * the discard. It IS that discard: the whole branch goes, the same as tapping
	 * the trash icon on the cell. Any other media in the carousel (older turns,
	 * other branches) still gets no Delete here. Destructive media deletion
	 * outside a fan-out belongs to the gallery.
	 */
	readonly #column = $derived.by(() => {
		const fanout = this.#deps.triage();
		return this.media && fanout.isMedia
			? columnShowingMedia(fanout.columns, this.media.id)
			: undefined;
	});
	readonly discardable = $derived.by(
		() => !!this.#column && canDiscardColumn(this.#deps.triage().columns, this.#column),
	);

	/**
	 * The open image is one the media fan-out grid on screen is showing — the
	 * user is triaging it. The lightbox then trades its own actions for the
	 * grid's footer (star, re-roll, a comparison's pick, discard), so the swipe
	 * through a fresh grid offers what the grid does, and "Regenerate" means
	 * what it means there.
	 */
	readonly triaging = $derived(!!this.#column);
	/** Whether the grid's Regenerate is offered for the open image. */
	readonly canRegenerate = $derived.by(
		() => !!this.#column && this.#deps.triage().canRegenerate(this.#column),
	);
	/** Re-roll is offered but can't start yet: the grid is at its in-flight cap. */
	readonly regenerateBlocked = $derived.by(() =>
		atActiveBranchCapacity(this.#deps.triage().columns),
	);

	/** Media id whose star is in flight; see `MediaFavorites.pendingId`. */
	get favoritingId(): string | null {
		return this.#deps.favorites.pendingId;
	}

	constructor(deps: ChatLightboxDeps) {
		this.#deps = deps;
	}

	/** Close and drop the carousel set, on a conversation switch: a preview left
	 *  open (search, a toast's "Open" or a notification can navigate with it up)
	 *  belongs to the previous conversation, and a stale set could briefly leak
	 *  into a lightbox opened before the refetch lands. */
	reset(): void {
		this.siblings = [];
		this.media = null;
		this.openingFor = null;
		this.#items.clear();
	}

	close(): void {
		this.media = null;
		// Or an open still in flight (a swipe resolves mid-gesture, so "swipe, then
		// Escape" leaves one) lands after this and reopens the dismissed preview.
		this.openingFor = null;
		this.#items.clear();
	}

	/** Warm a slide the user may swipe to; MediaLightbox's `onPrefetch`. */
	prefetch(mediaId: string): void {
		this.#items.prefetch(mediaId);
	}

	async #loadSiblings(): Promise<void> {
		const forConversation = this.#deps.conversationId();
		try {
			const res = await fetch(`/api/conversations/${forConversation}/media`);
			if (!res.ok) return; // carousel just stays single-item; non-fatal
			const body = (await res.json()) as { items: ConversationMediaRef[] };
			// The user switched conversations while this was in flight.
			if (this.#deps.conversationId() !== forConversation) return;
			// The set arrives oldest-first, i.e. in COMPLETION order — which is not
			// the order a live fan-out grid is drawn in (that's the order the models
			// were enqueued in). Parallel branches finish out of order, so without
			// this the carousel walked the same images in a different sequence than
			// the grid the tap came from. Re-seated once, here, rather than derived:
			// the set is only fetched on the initial open, so the carousel's order
			// stays put for the life of that open session.
			this.siblings = applyDisplayOrder(body.items, gridMediaIds(this.#deps.triage().columns));
		} catch {
			// Network blip — leave the set as-is; the lightbox still opens
			// on the tapped image, just without sibling navigation.
		}
	}

	async open(mediaId: string): Promise<void> {
		if (this.openingFor === mediaId) return;
		// Initial open (lightbox was closed) — also (re)load the carousel
		// set so swipe/arrows have somewhere to go, and so just-generated
		// images are included. A swipe-driven navigate calls this with the
		// lightbox already open, so it skips the refetch.
		if (!this.media) void this.#loadSiblings();
		// Already fetched (usually by a prefetch): swap it in synchronously, so the
		// header changes in the same frame as the swipe that asked for it. Clearing
		// `openingFor` also drops whatever slower open is still in flight.
		const cached = this.#items.peek(mediaId);
		if (cached) {
			this.openingFor = null;
			this.media = this.#withStar(cached);
			return;
		}
		this.openingFor = mediaId;
		try {
			const m = await this.#items.load(mediaId);
			if (this.openingFor === mediaId) this.media = this.#withStar(m);
		} catch (e) {
			if (this.openingFor === mediaId) {
				toast.error(`Couldn't load image details: ${e instanceof Error ? e.message : String(e)}`);
			}
		} finally {
			if (this.openingFor === mediaId) this.openingFor = null;
		}
	}

	/** The star `open` would show for `mediaId` right now, if its row is in
	 *  hand; MediaLightbox's `peekFavorite`. */
	peekFavorite(mediaId: string): boolean | undefined {
		const row = this.#items.peek(mediaId);
		if (!row) return undefined;
		const { favorites } = this.#deps;
		return favorites.pendingId === mediaId
			? favorites.isFavorite(mediaId, row.favorite)
			: row.favorite;
	}

	/** A fetched row, reconciled with the page's stars: its own `favorite` is
	 *  server truth, recorded for the grid, unless a star is in flight for it,
	 *  in which case the optimistic value wins (the read may predate the write). */
	#withStar(m: MediaListItem): MediaListItem {
		const { favorites } = this.#deps;
		if (favorites.pendingId !== m.id) {
			favorites.observe(m.id, m.favorite);
			return m;
		}
		const favorite = favorites.isFavorite(m.id, m.favorite);
		return favorite === m.favorite ? m : { ...m, favorite };
	}

	/**
	 * Star / unstar the open image, so the "that one came out well" reaction can
	 * happen where it actually occurs — right after generating — instead of
	 * requiring a later trip to the gallery.
	 *
	 * The request is the page's `MediaFavorites`, shared with the fan-out grid's
	 * star; this flips the lightbox's own copy of the row alongside it. No
	 * `invalidate` to run — that route deliberately avoids one (it ships a window
	 * of the active branch with `content_html`, so re-running its load to move a
	 * star would re-serialize all of it). The gallery re-reads the truth from the
	 * server on its own next load.
	 */
	async toggleFavorite(mediaId: string, next: boolean): Promise<void> {
		if (this.#deps.favorites.pendingId) return;
		const show = (favorite: boolean) => {
			if (this.media?.id === mediaId) this.media = { ...this.media, favorite };
			// Or swiping away and back would bring the old star with it.
			this.#items.patch(mediaId, { favorite });
		};
		show(next);
		if (!(await this.#deps.favorites.toggle(mediaId, next))) show(!next);
	}

	/**
	 * The grid's Regenerate, from the lightbox: another variation from the open
	 * image's model, added to the grid beside it. The carousel's set is loaded
	 * once per open, so the new variation shows in the grid but not here until
	 * the lightbox reopens; the toast is what says the tap did something.
	 */
	regenerate(mediaId: string): void {
		const fanout = this.#deps.triage();
		const col = columnShowingMedia(fanout.columns, mediaId);
		if (!col || !fanout.canRegenerate(col) || this.regenerateBlocked || fanout.picking) return;
		void fanout.regenerate(col);
		toast.info('Generating another variation');
	}

	/**
	 * A photo or portrait comparison's pick, from the lightbox. It ends the
	 * comparison, so the lightbox closes with it rather than leave the user
	 * swiping a set whose grid no longer exists.
	 */
	pick(mediaId: string): void {
		const fanout = this.#deps.triage();
		const col = columnShowingMedia(fanout.columns, mediaId);
		if (!col || fanout.picking) return;
		this.close();
		void fanout.pick(col);
	}

	/**
	 * Discard the branch behind the lightbox's current image, then move to the
	 * next image. The gallery closes on delete; here the point is to prune a
	 * grid by swiping through it, so closing would send the user back to the
	 * grid after every dud.
	 *
	 * The new image's metadata is fetched BEFORE the carousel set shrinks, and
	 * both are swapped in together. The lightbox treats a `media` missing from
	 * `siblings` as a single item, so shrinking first would drop the carousel for
	 * the length of that fetch and bring it back unpositioned. The track's scroll
	 * offset doesn't move when slides leave, so the image to show is whichever
	 * survivor now fills the current slot (see survivorInSlot). For a single-image
	 * branch that's the next image.
	 */
	async discard(mediaId: string): Promise<void> {
		const fanout = this.#deps.triage();
		const col = columnShowingMedia(fanout.columns, mediaId);
		// A refused discard (grid busy) must not reach the toast below, which
		// would repeat whatever stale error the banner last held.
		if (!col || this.deletingId || fanout.picking) return;
		// Everything the branch showed leaves the carousel with it (a batch
		// branch has several images).
		const removed = new Set(columnMediaIds(col));
		const forConversation = this.#deps.conversationId();
		this.deletingId = mediaId;
		try {
			if (!(await fanout.discard(col))) {
				// The banner the controller set sits under the lightbox.
				const error = this.#deps.error();
				if (error) toast.error(`Couldn't delete: ${error}`);
				return;
			}
			// What's on screen NOW, which a swipe during the discard may have moved
			// off `mediaId` — onto another image of the same batch branch, which is
			// leaving too. Left there, `media` would be missing from `siblings`,
			// which drops the lightbox to its single-item view: no track to swipe.
			const shownId = this.media?.id;
			const leaving = shownId !== undefined && removed.has(shownId);
			const next = leaving ? survivorInSlot(this.siblings, shownId, removed) : null;
			const survivors = this.siblings.filter((m) => !removed.has(m.id));
			let nextItem: MediaListItem | null = null;
			for (const id of removed) this.#items.delete(id);
			if (next) {
				try {
					nextItem = await this.#items.load(next.id);
				} catch {
					// Close instead. The discard itself went through.
				}
			}
			// The user switched conversations during the round trips: the lightbox
			// was reset, and this set belongs to the chat they left.
			if (this.#deps.conversationId() !== forConversation) return;
			// A swipe onto a leaving image whose row is still loading (the deletes
			// above evicted it, so it fetches, or joins a prefetch already in
			// flight) would land after this and put `media`
			// back on an image `siblings` no longer has. Drop it, as `close` drops an
			// open in flight; an open of a surviving image is left to land.
			if (this.openingFor !== null && removed.has(this.openingFor)) this.openingFor = null;
			// The user may have closed the lightbox or swiped elsewhere during the
			// round trips. Update the set either way, but only move `media` if it
			// still shows what `next` was picked for. If a swipe moved it onto
			// another leaving image during the fetch, there's no row in hand for
			// that one's slot: close, as when there's nothing to move to, rather
			// than strand it.
			this.siblings = survivors;
			if (leaving && this.media?.id === shownId) {
				// Through `#withStar` like every other row the lightbox shows, so the
				// page's stars hear about it too.
				this.media = nextItem && this.#withStar(nextItem);
				if (!nextItem) this.#items.clear();
			} else if (this.media && removed.has(this.media.id)) {
				this.media = null;
				this.#items.clear();
			}
		} finally {
			this.deletingId = null;
		}
	}
}
