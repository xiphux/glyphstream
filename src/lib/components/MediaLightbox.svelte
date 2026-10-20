<script lang="ts">
	import { errorMessageFromResponse } from '#lib/fetch-error.js';
	import { formatBytes } from '#lib/format.js';
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { untrack } from 'svelte';
	import { MediaQuery } from 'svelte/reactivity';
	import { Popover } from 'bits-ui';
	import {
		Check,
		ChevronLeft,
		ChevronRight,
		Download,
		ImagePlus,
		RotateCcw,
		Share,
		Star,
		Trash2,
		Undo2,
		UserRound,
		X,
	} from '@lucide/svelte';
	import type { MediaConversationRef, MediaKind, MediaListItem } from '#lib/types/api.js';
	import { GALLERY_LAUNCH_KEY, type GalleryLaunchIntent } from '#lib/gallery-launch.js';
	import { endpointIdOf, friendlyModelName, mediaSourceModelId } from '#lib/model-ids.js';

	interface Props {
		/** The media being shown; null means the lightbox is closed (renders nothing). */
		media: MediaListItem | null;
		/** Called when the user closes via Escape, the X button, or backdrop click. */
		onClose: () => void;
		/**
		 * Optional Delete action. The gallery always wires it up. A conversation
		 * wires it only while the shown image belongs to an open media fan-out
		 * grid, where it discards that branch like the grid's trash button.
		 * Otherwise the chat has its own message-level controls, and deleting
		 * media from inside a chat is the wrong context. The caller decides what
		 * happens next: the gallery closes, a fan-out advances to the next image.
		 */
		onDelete?: (id: string) => void | Promise<void>;
		/** Media id currently being deleted, used to disable the delete button. */
		deletingId?: string | null;
		/**
		 * Optional Restore action — the trash's counterpart to `onDelete`, wired
		 * only by Recently deleted (alongside `trashed`). Same division of labour:
		 * the caller owns the request and decides what's shown next.
		 */
		onRestore?: (id: string) => void | Promise<void>;
		/** Media id currently being restored, used to disable the restore button. */
		restoringId?: string | null;
		/**
		 * Optional "conversations referencing this media" section.
		 *  - `undefined`: don't render the section at all (chat-side use case).
		 *  - `null`: render a "Loading…" placeholder (in-flight fetch).
		 *  - `[]`: render "Not used in any conversation".
		 *  - `MediaConversationRef[]`: render the list with click-through links.
		 */
		conversationsUsingThis?: MediaConversationRef[] | null;
		conversationsError?: string | null;
		/**
		 * Set to true when the lightbox is mounted inside a conversation
		 * (i.e. the chat-page caller). Adjusts the gallery-launch button
		 * labels to make it explicit that they start a *new* conversation
		 * rather than continuing the one the user is already in — without
		 * this, "Regenerate with this prompt" reads ambiguously, like it
		 * might re-run the generation inside the current chat. From the
		 * gallery surface there's no current conversation to confuse with,
		 * so the default (false) keeps the concise wording.
		 */
		inConversation?: boolean;
		/**
		 * Ordered set the lightbox can navigate between (carousel mode).
		 * Each entry is just `{ id, kind }` — enough to render every slide
		 * (`/content` for the image/video, kind to pick the element) without
		 * resolving full metadata for the whole set up front. `media` is the
		 * currently-shown member; the caller swaps it in response to
		 * `onNavigate`. Arrows / swipe / arrow-keys only appear when there
		 * are 2+ entries; omit it (or pass a single-entry list) and the
		 * lightbox renders exactly as the pre-carousel single-item view.
		 */
		siblings?: Array<{ id: string; kind: MediaKind }>;
		/**
		 * Called when the user swipes / clicks an arrow / presses an arrow
		 * key to move to a different sibling. The caller resolves the id to
		 * a full MediaListItem and feeds it back in via `media` (gallery has
		 * it in memory; chat fetches it). Required for navigation to do
		 * anything — without it the carousel is inert.
		 */
		onNavigate?: (id: string) => void;
		/**
		 * Called with the neighbours of the slide on screen, so the caller can
		 * fetch their rows before the user swipes to one. A swipe resolves at its
		 * midpoint, and if the row is already in hand the header (model, star,
		 * delete) changes along with the image instead of a round trip later.
		 * Optional: without it a swipe still resolves, just not instantly.
		 */
		onPrefetch?: (id: string) => void;
		/**
		 * Things this image can be made the avatar of — custom-model presets, and
		 * (from a conversation) that conversation itself. Empty / omitted hides
		 * the action entirely.
		 *
		 * `kind` is what the caller routes on: the two land on different
		 * endpoints because they're different rows with different lifetimes, and
		 * collapsing them here would make this component decide something it has
		 * no business deciding.
		 *
		 * Passed in rather than read from a store because this component is used
		 * from both the gallery and a conversation, and only the latter has a
		 * conversation to offer.
		 */
		avatarTargets?: Array<{
			kind: 'preset' | 'conversation';
			id: string;
			name: string;
			avatarMediaId: string | null;
		}>;
		/** Performs the change. The caller owns the request + its toast, matching
		 *  how `onDelete` works — this component stays presentational. */
		onSetAvatar?: (
			target: { kind: 'preset' | 'conversation'; id: string },
			mediaId: string,
		) => void | Promise<void>;
		/** Disables the action while a change is in flight. */
		settingAvatar?: boolean;
		/**
		 * Optional favorite toggle. The caller owns the request, its toast and the
		 * optimistic flip of `media.favorite` — same division as `onDelete` and
		 * `onSetAvatar`; this component stays presentational.
		 *
		 * Omit it to hide the star. The chat-side caller omits it for an UPLOADED
		 * asset on purpose: a star promises "keep this and let me find it again in
		 * the gallery", and the gallery lists only generated media, so offering one
		 * there would be a button whose second half can never be honoured.
		 */
		onToggleFavorite?: (id: string, next: boolean) => void | Promise<void>;
		/** Media id whose star is in flight. Disables the button for the WHOLE
		 *  carousel, not just this slide: both callers guard with a single
		 *  `if (favoritingId) return`, so a star clicked on another slide mid-flight
		 *  was dropped on the floor with no error and no toast. Disabling everywhere
		 *  makes the button say what the guard actually does. */
		favoritingId?: string | null;
		/**
		 * Showing an item from Recently deleted. Its bytes are only served with
		 * `?trash=1` (see `servableForRequest`), and the actions that aren't
		 * optional props — download/share, regenerate, use as starting image —
		 * are withheld: the page exists to decide between restore and
		 * delete-forever, and every one of those would act on something that's
		 * about to be gone. Restore first.
		 */
		trashed?: boolean;
	}

	let {
		media,
		onClose,
		onDelete,
		deletingId = null,
		onRestore = undefined,
		restoringId = null,
		conversationsUsingThis = undefined,
		conversationsError = null,
		inConversation = false,
		siblings = undefined,
		onNavigate = undefined,
		onPrefetch = undefined,
		avatarTargets = [],
		onSetAvatar = undefined,
		settingAvatar = false,
		onToggleFavorite = undefined,
		favoritingId = null,
		trashed = false,
	}: Props = $props();

	/** Query suffix for every byte URL this component renders. */
	const bytesQuery = $derived(trashed ? '?trash=1' : '');

	// --- carousel navigation ---------------------------------------------
	//
	// Position of the open item within `siblings`. -1 when there's no set,
	// no open item, or the open item isn't in the set — all of which fall
	// back to the single-item layout below.
	const currentIndex = $derived(
		siblings && media ? siblings.findIndex((s) => s.id === media.id) : -1,
	);
	const showCarousel = $derived(!!siblings && siblings.length > 1 && currentIndex >= 0);

	/** How many slides either side of the current one actually mount their media.
	 *  Two is enough that a swipe or arrow press always lands on something already
	 *  decoded, while keeping the mounted set constant regardless of library size. */
	const SLIDE_WINDOW = 2;

	let trackEl = $state<HTMLDivElement | null>(null);

	// True once we've performed the initial (instant) scroll-to-position
	// for the current open session, so subsequent arrow/key moves animate.
	// Reset whenever the lightbox closes (media → null).
	let hasPositioned = false;
	$effect(() => {
		if (!media) hasPositioned = false;
	});

	// "Enhanced — show original" toggle for the prompt strip. Reset whenever the
	// shown media changes (carousel navigation) so each image starts collapsed.
	let showOriginal = $state(false);
	$effect(() => {
		void media?.id;
		showOriginal = false;
	});

	// Jump the track to the opening slide once, instantly, when the
	// lightbox opens. After that, scrolling is owned by the gesture (native
	// swipe) and by `navigate()` (arrows/keys do their own smooth scroll) —
	// re-running this on every `currentIndex` change would either fight an
	// in-flight swipe or double up on the arrow scroll, so it early-returns
	// once positioned. `snap-mandatory` keeps the right slide centered
	// across viewport resizes / orientation changes on its own.
	$effect(() => {
		const el = trackEl;
		const idx = currentIndex;
		if (!el || idx < 0 || hasPositioned) return;
		el.scrollTo({ left: idx * el.clientWidth, behavior: 'auto' });
		hasPositioned = true;
	});

	// Follow `media` when the caller moves it somewhere the track isn't — the
	// trash restoring the open item and stepping to its neighbour, or the
	// slides shifting under it when a reload drops one. Left on the old slide,
	// the next scroll event (any re-snap) reads that slide's index as a swipe
	// and resolves it, dragging `media` back; when that's the item the caller
	// just removed, the lightbox closes. A user's own navigation never trips
	// this: a swipe resolves the slide the track is already on, and an arrow
	// press is skipped while its `pendingIndex` / `scrollTarget` is live.
	$effect(() => {
		const el = trackEl;
		const idx = currentIndex;
		if (!el || idx < 0) return;
		untrack(() => {
			if (!hasPositioned || el.clientWidth === 0) return;
			if (pendingIndex !== null || scrollTarget !== null || touchActive || touchReleased) return;
			if (Math.round(el.scrollLeft / el.clientWidth) === idx) return;
			el.scrollTo({ left: idx * el.clientWidth, behavior: 'auto' });
		});
	});

	// Swipe handler. A swipe resolves the slide it's heading for as soon as it
	// crosses the midpoint with the finger down, not once the scroll settles:
	// until `media` moves, the header describes the slide the user is swiping
	// away from — a lit star over an unstarred image, and a star or trash button
	// that acts on the previous image if tapped. Settling took the snap
	// animation, the debounce below and then (chat) a fetch; with the caller
	// prefetching neighbours (`onPrefetch`) the midpoint swap is usually
	// synchronous.
	//
	// It used to wait for the settle for two reasons that no longer hold. One
	// resolve per landing rather than per slide crossed: `snap-always` stops a
	// flick at the adjacent slide, so there is one crossing per swipe, and the
	// crossings go through the same coalescer as arrow presses. And the swap
	// reflowed the image mid-slide, because the prompt strip below the track
	// changes height with the prompt; in carousel mode that strip now reserves
	// its full height (see the prompt markup).
	//
	// The settle stays as the backstop and the final word on where the user
	// landed — the midpoint is a guess the finger can still take back.
	//
	// A flick is the exception: it crosses the midpoint after the finger lifts,
	// mid-snap-animation, where any DOM change makes iOS drop the snap (see
	// `coasting` in `onTrackScroll`). So it resolves at the settle, and until then
	// the header — counter, star, delete — is still the previous slide's, actions
	// live. Marking it `stale` would be a DOM change too; the window is the
	// coast plus the debounce, and a tap on the track ends the coast anyway.
	let scrollSettleTimer: ReturnType<typeof setTimeout> | undefined;
	/**
	 * The slide a smooth `scrollTo` from `navigate()` is heading for. The track
	 * passes through every slide between, and resolving those would drag a key
	 * burst's `pendingIndex` back toward where the animation currently is.
	 * Cleared when the track arrives, and by the settle in case it never does.
	 */
	let scrollTarget: number | null = null;
	/** The id most recently handed to `onNavigate`, so the settle can tell when a
	 *  resolve it didn't end up wanting may still be in flight. */
	let lastResolvedId: string | null = null;
	/**
	 * A finger is on the track, and whether one has lifted since the track last
	 * came to rest. Feeds the settle's re-snap: a fast flick crosses the midpoint
	 * after the finger lifts, while the browser's own snap animation is running,
	 * and the swap that crossing triggers (header, mounted slides, `loading`) is a
	 * layout change mid-animation. iOS WebKit can drop the snap there and leave
	 * the track resting partway onto the next slide. A gentle drag crosses with
	 * the finger still down, so the release snaps normally — which is why only a
	 * real flick got stuck. `onTrackScroll` now makes no DOM change while
	 * coasting; the re-snap stays as the backstop for anything else that lays
	 * out mid-animation.
	 *
	 * A release stays armed only if the track keeps moving after it: disarmed
	 * unless a scroll arrives within RELEASE_MOTION_MS. A tap, or a hold that
	 * lifts on a slide, would otherwise leave it armed until some later settle —
	 * on a device with a trackpad too, a two-finger swipe paused mid-gesture.
	 * Judged after the lift rather than by whether the finger moved the track:
	 * scroll events are per-frame and `touchend` isn't, so the shortest flick can
	 * lift before its first scroll event.
	 */
	let touchActive = false;
	let touchReleased = false;
	const RELEASE_MOTION_MS = 90;
	let releaseMotionTimer: ReturnType<typeof setTimeout> | undefined;
	function onTrackTouchStart() {
		touchActive = true;
		touchReleased = false;
		clearTimeout(releaseMotionTimer);
	}
	function onTrackTouchEnd(e: TouchEvent) {
		if (e.touches.length > 0) return;
		touchActive = false;
		touchReleased = true;
		releaseMotionTimer = setTimeout(() => (touchReleased = false), RELEASE_MOTION_MS);
	}
	function onTrackScroll() {
		const el = trackEl;
		if (!el || !siblings) return;
		if (!touchActive) clearTimeout(releaseMotionTimer);
		// Coasting: the finger has lifted and the browser's snap animation is
		// carrying the track. None of the writes below happens then — the header
		// swap and the mounting window change the DOM, and a layout change
		// mid-animation is what makes iOS drop the snap and overshoot onto the
		// slide after (`touchActive`). The settle resolves where it landed
		// instead. `snap-always` stops a flick on the adjacent slide, which the
		// window around `currentIndex` already has mounted, so nothing is
		// missing on arrival. An arrow press's `scrollTarget` is cleared by the
		// settle instead.
		const coasting = touchReleased && !touchActive;
		if (el.clientWidth > 0 && !coasting) {
			// Rounding flips at the halfway point between two slides. Writing
			// `pendingIndex` re-runs every slide's `slideMounted` (see below), but
			// once per swipe, like an arrow press, not once per scroll event.
			const idx = Math.round(el.scrollLeft / el.clientWidth);
			if (scrollTarget !== null) {
				if (idx === scrollTarget) scrollTarget = null;
			} else if (idx !== displayIndex && siblings[idx]) {
				pendingIndex = idx;
				resolveSlide(siblings[idx].id);
			}
			// Track the live position while scrolling (except coasting, above), not
			// just on settle — that's what keeps the slides being scrolled through
			// mounted.
			//
			// Quantized to SLIDE_WINDOW steps rather than written per crossed slide.
			// `slideMounted` is called inside the per-item `{#if}` of an each-block
			// over every unit loaded this gallery session (thousands after a deep
			// scroll), so in Svelte 5 every sibling's block effect subscribes to this
			// one `$state`. Writing it per slide re-runs all of them per slide; at
			// this granularity the mounted set only shifts when the position has
			// moved far enough to actually change it.
			const snapped = Math.min(
				siblings.length - 1,
				Math.max(0, Math.round(idx / SLIDE_WINDOW) * SLIDE_WINDOW),
			);
			if (snapped !== scrolledIndex) scrolledIndex = snapped;
		}
		clearTimeout(scrollSettleTimer);
		scrollSettleTimer = setTimeout(() => {
			const idx = Math.round(el.scrollLeft / el.clientWidth);
			const landed = siblings[idx];
			// Couldn't read a position (a zero-width track makes `idx` NaN) — say
			// nothing rather than cancelling work that may still be wanted.
			if (!landed) return;
			scrollTarget = null;
			// Came to rest off the grid after a touch gesture: the browser dropped
			// the snap (see `touchActive`), so finish it. Only after a release —
			// with a finger still down, resting between slides is the user holding
			// it there, and a trackpad gesture snaps on its own when it ends.
			if (touchReleased && !touchActive) {
				touchReleased = false;
				const left = idx * el.clientWidth;
				if (Math.abs(el.scrollLeft - left) > 1) el.scrollTo({ left, behavior: 'smooth' });
			}
			if (landed.id === media?.id) {
				// Settled back on what's already shown — so anything still queued is
				// stale, and letting it fire would drag `media` away from the slide the
				// user is looking at. Reachable by arrowing forward (leaving a trailing
				// resolve armed) and swiping back inside the same window, and by
				// dragging past a midpoint and back without letting go.
				clearTimeout(navResolveTimer);
				pendingIndex = null;
				// A resolve that already went out may still be in flight: the midpoint
				// asked for the next slide, the caller started fetching it, and the
				// finger came back. Re-asking for this slide supersedes it — both
				// callers drop a response for anything but their latest request.
				if (lastResolvedId !== null && lastResolvedId !== landed.id) {
					lastResolvedId = landed.id;
					onNavigate?.(landed.id);
				}
				return;
			}
			// Through the coalescer, not straight to `onNavigate`. Calling directly
			// left the two paths on separate clocks: arrow-press twice (a trailing
			// resolve queued for slide 2), then swipe back to slide 0 — the settle
			// fires first, then the still-queued trailing resolve yanks `media` to
			// slide 2 while the track sits at 0. Sharing the queue means the last
			// intent wins, whichever path produced it.
			pendingIndex = idx;
			resolveSlide(landed.id);
		}, 90);
	}

	function navigate(delta: number) {
		if (!siblings || currentIndex < 0) return;
		// Step from where the user has already navigated TO, not from where the
		// resolve has caught up to. `currentIndex` follows `media`, which only moves
		// once the caller resolves `onNavigate` — and that resolve is coalesced by
		// up to NAV_RESOLVE_WINDOW_MS. Stepping from `currentIndex` therefore made
		// every press inside one window compute the same target: five quick presses
		// landed two slides along, not five. Coalescing is meant to drop redundant
		// metadata fetches, not to drop the navigation itself.
		const from = pendingIndex ?? currentIndex;
		const next = from + delta;
		if (next < 0 || next >= siblings.length) return;
		pendingIndex = next;
		// Scroll immediately for instant feedback rather than waiting for the
		// metadata fetch (chat) to round-trip through `media` → currentIndex →
		// the positioning effect. The effect then no-ops (already centered).
		const el = trackEl;
		if (el) {
			const left = next * el.clientWidth;
			// Only when the track will actually move. A scroll to where it already
			// is emits no scroll event, so nothing would ever clear the target, and
			// the next swipe would skip its midpoint resolve. Cleared rather than
			// left alone in that case: an earlier press's target may still be armed
			// (Right then Left inside one frame), and this scrollTo cancels the
			// smooth scroll that would have reached it.
			scrollTarget = el.scrollLeft !== left ? next : null;
			el.scrollTo({ left, behavior: 'smooth' });
		}
		resolveSlide(siblings[next].id);
	}

	/**
	 * Where the user has navigated to, ahead of `media` catching up. Null when
	 * they agree — so at rest every read of it falls through to `currentIndex`.
	 */
	let pendingIndex = $state<number | null>(null);
	$effect(() => {
		if (pendingIndex !== null && (currentIndex === pendingIndex || currentIndex < 0)) {
			pendingIndex = null;
		}
	});
	// A pending index is an offset into `siblings`, so it's meaningless the moment
	// that array is swapped — toggling drill-in or search replaces the source
	// outright and the offset would then point at a different item.
	//
	// Keyed on what the offset actually depends on rather than on array identity:
	// the gallery's `siblings` is a fresh array literal derived from the feed, so
	// identity changes whenever the feed absorbs a unit. Nothing can mutate the
	// feed while the lightbox covers the grid today, but relying on that would
	// make a live key burst silently resettable by an unrelated background load.
	let siblingsKey = $derived(siblings ? `${siblings.length}:${siblings[0]?.id ?? ''}` : '');
	$effect(() => {
		void siblingsKey;
		pendingIndex = null;
	});

	/** The slide the UI should present as current: where the user has navigated to,
	 *  falling back to where `media` actually is. Keeps the counter and the arrow
	 *  disabled-states from lagging a key burst by up to NAV_RESOLVE_WINDOW_MS. */
	const displayIndex = $derived(pendingIndex ?? currentIndex);

	/**
	 * The slide on screen isn't the one `media` describes yet — the user has
	 * swiped or arrowed on and the caller hasn't resolved it. Everything in the
	 * header and below is still about the previous image, and every action there
	 * acts on `media.id`, so they're disabled (and the star shows neither state)
	 * rather than offering to favorite or delete an image the user has left.
	 * Usually never rendered: with the row prefetched, `media` moves in the same
	 * tick as `pendingIndex`.
	 */
	const stale = $derived(showCarousel && displayIndex !== currentIndex);

	// Warm the rows either side of the resolved slide, so the next swipe either
	// way resolves without a round trip.
	//
	// Keyed on `currentIndex`, not `displayIndex`. The latter moves on every arrow
	// press, auto-repeat included, so holding a key prefetched one uncancelled
	// `/api/media/:id` per slide flown past — the load `resolveSlide`'s coalescer
	// exists to stop. `currentIndex` only moves when a resolve lands, so it shares
	// that rate limit. A swipe loses nothing: on a cache hit the caller swaps
	// `media` synchronously, so `currentIndex` moves in the same tick.
	$effect(() => {
		if (!showCarousel || !onPrefetch || !siblings) return;
		for (const i of [currentIndex - 1, currentIndex + 1]) {
			const s = siblings[i];
			if (s) onPrefetch(s.id);
		}
	});

	/**
	 * Which slide the track is actually showing, when that's ahead of
	 * `currentIndex`.
	 *
	 * `currentIndex` is derived from `media`, which only updates once the caller
	 * resolves `onNavigate` — after a metadata fetch, and now after up to
	 * `NAV_RESOLVE_WINDOW_MS` of coalescing. A swipe moves the track under the
	 * user's finger the whole time, so windowing on `currentIndex` alone renders
	 * everything flown past as an empty slot until the scroll settles. Before the
	 * window existed every slide was mounted, so the same lag was invisible.
	 *
	 * Fed from the live scroll position rather than from `navigate()` so it covers
	 * the swipe case too — and so arrow navigation keeps computing from
	 * `currentIndex`, which is what decides where a press actually goes.
	 */
	let scrolledIndex = $state<number | null>(null);
	$effect(() => {
		if (scrolledIndex !== null && (currentIndex === scrolledIndex || currentIndex < 0)) {
			scrolledIndex = null;
		}
	});

	/** Mount a slide's media if it's near the settled position, the one the track
	 *  has scrolled to, or the one a key burst has already navigated to. Separate
	 *  windows rather than the span between them, so a long inertial swipe can't
	 *  mount everything it passed. At rest the latter two are null and this is just
	 *  the window around `currentIndex`. */
	function slideMounted(i: number): boolean {
		if (Math.abs(i - currentIndex) <= SLIDE_WINDOW) return true;
		if (scrolledIndex !== null && Math.abs(i - scrolledIndex) <= SLIDE_WINDOW) return true;
		return pendingIndex !== null && Math.abs(i - pendingIndex) <= SLIDE_WINDOW;
	}

	/**
	 * Rate-limit the metadata resolve behind arrow-key navigation.
	 *
	 * Leading edge, so one press still resolves immediately — that's what keeps
	 * the caption/model panel responsive, and it's the behaviour the carousel
	 * tests pin. Subsequent presses inside the window are coalesced into a single
	 * trailing call for wherever the user ended up. Holding an arrow key used to
	 * emit ~30 resolves a second, each an uncancelled `/api/media/:id` plus
	 * `/api/media/:id/conversations` (neither deduped nor aborted), for slides
	 * being flown past.
	 *
	 * "Wherever the user ended up" means the trailing call reads `pendingIndex` at
	 * FIRE time rather than resolving whichever id was captured when it was queued
	 * — otherwise it lands one slide past the last resolved position instead of at
	 * the end of the burst.
	 *
	 * Deliberately not routed through `onTrackScroll`'s settle timer instead: a
	 * smooth `scrollTo` that emits no scroll event — no track element, reduced
	 * motion, a non-browser environment — would leave navigation resolving
	 * nothing at all. (The reverse direction is fine and is done below: the settle
	 * path feeds INTO this coalescer, so both share one queue and one clock.)
	 */
	const NAV_RESOLVE_WINDOW_MS = 120;
	let navResolveTimer: ReturnType<typeof setTimeout> | undefined;
	let navResolveBlockedUntil = 0;
	function resolveSlide(id: string) {
		clearTimeout(navResolveTimer);
		const now = Date.now();
		if (now >= navResolveBlockedUntil) {
			navResolveBlockedUntil = now + NAV_RESOLVE_WINDOW_MS;
			lastResolvedId = id;
			onNavigate?.(id);
			return;
		}
		navResolveTimer = setTimeout(() => {
			navResolveBlockedUntil = Date.now() + NAV_RESOLVE_WINDOW_MS;
			const target = pendingIndex !== null ? siblings?.[pendingIndex]?.id : undefined;
			lastResolvedId = target ?? id;
			onNavigate?.(lastResolvedId);
		}, navResolveBlockedUntil - now);
	}

	// Drop queued work when the lightbox closes. The gallery mounts this component
	// unconditionally and closes it by setting `media` to null, so nothing tears it
	// down — without this, a trailing resolve queued by the last arrow press fires
	// up to NAV_RESOLVE_WINDOW_MS later and calls `onNavigate`, which reopens the
	// lightbox the user just dismissed. Same for the swipe settle timer.
	$effect(() => {
		if (media) return;
		clearTimeout(navResolveTimer);
		clearTimeout(scrollSettleTimer);
		navResolveBlockedUntil = 0;
		scrolledIndex = null;
		pendingIndex = null;
		scrollTarget = null;
		lastResolvedId = null;
		clearTimeout(releaseMotionTimer);
		touchActive = false;
		touchReleased = false;
	});
	// And on teardown, for callers that do unmount it.
	$effect(() => () => {
		clearTimeout(navResolveTimer);
		clearTimeout(scrollSettleTimer);
		clearTimeout(releaseMotionTimer);
	});

	function fmtDate(ms: number): string {
		return new Date(ms).toLocaleString();
	}

	// Escape-to-close lives on window so it works regardless of focus —
	// the lightbox is intentionally a tabindex=-1 dialog (not a focus
	// trap) so the Escape semantic needs to be global. Early-return when
	// no media is open so unrelated keypresses don't reach onClose.
	//
	// An Escape something else already handled is not ours. bits-ui layers
	// (the "Set as avatar" picker, any open tooltip) close on Escape from a
	// `document` listener and call preventDefault; this one is on `window`, so
	// it sees the same event afterwards and would close the lightbox too.
	function onKey(e: KeyboardEvent) {
		if (!media) return;
		if (e.key === 'Escape') {
			if (!e.defaultPrevented) onClose();
			return;
		}
		// Arrow-key navigation, only meaningful in carousel mode. Guarded
		// so a left/right press in (say) a focused download button doesn't
		// also page the carousel — but the lightbox isn't a focus trap and
		// has no text inputs, so a bare arrow press is unambiguous here.
		if (!showCarousel) return;
		if (e.key === 'ArrowLeft') {
			e.preventDefault();
			navigate(-1);
		} else if (e.key === 'ArrowRight') {
			e.preventDefault();
			navigate(1);
		}
	}

	function sourceModelIdFor(m: MediaListItem): string | null {
		// The internal `endpointId::upstreamId` form the model picker uses.
		// `sourceModel` normally already IS that id, so this is mostly a
		// pass-through — see `mediaSourceModelId` for why joining the two
		// columns unconditionally (what this used to do) yielded a doubled
		// prefix that never resolved. Null for legacy uploads and rows from
		// before the source-model fields were captured, which lets the
		// new-chat page pick its own default.
		return mediaSourceModelId(m.sourceEndpointId, m.sourceModel);
	}

	/**
	 * The endpoint half of the id the regenerate buttons would launch with.
	 *
	 * Rendered in the metadata line because the header's friendly label drops
	 * the prefix, and two endpoints serving the same model then collapse to one
	 * name. Derived from `sourceModelIdFor` rather than read off
	 * `sourceEndpointId` so the endpoint shown is always the one belonging to
	 * the id the buttons actually use. Null when no endpoint is recorded —
	 * uploads and `run_python` outputs, which have nothing to regenerate on.
	 */
	function sourceEndpointLabel(m: MediaListItem): string | null {
		const id = sourceModelIdFor(m);
		return id ? endpointIdOf(id) : null;
	}

	/**
	 * The secondary line under the model name: endpoint (when there is one),
	 * date, aspect ratio (when recorded), size, content type.
	 *
	 * Assembled here rather than interpolated with an `{#if}` in the markup.
	 * Svelte trims trailing whitespace at the END of an if-fragment, so the
	 * obvious `{#if e}{e} · {/if}{fmtDate(…)}` silently renders
	 * `bridge-dev ·5/1/2026` — the separator keeps its `·` and loses its space,
	 * and moving the space inside the block doesn't help because that is the
	 * whitespace being trimmed. A join can't get that wrong.
	 */
	function metaLine(m: MediaListItem): string {
		const endpoint = sourceEndpointLabel(m);
		const parts = endpoint ? [endpoint] : [];
		parts.push(fmtDate(m.createdAt));
		// Absent for uploads, for pre-feature rows, and for every upstream that
		// doesn't report a ratio — which is most of them, so this segment is the
		// exception rather than the rule.
		if (m.aspectRatio) parts.push(m.aspectRatio);
		parts.push(formatBytes(m.byteSize), m.contentType);
		return parts.join(' · ');
	}

	function stashIntent(intent: GalleryLaunchIntent): void {
		try {
			window.sessionStorage.setItem(GALLERY_LAUNCH_KEY, JSON.stringify(intent));
		} catch {
			// sessionStorage can throw (private mode, quota, disabled).
			// We don't have a great fallback — proceed with navigation
			// and let the user re-pick on the new-chat page.
		}
	}

	/** The prompt that generated this image — the ENHANCED prompt when the
	 *  enhancer rewrote it (promptFull holds the enhanced text), else the
	 *  verbatim prompt. Falls back to promptExcerpt for legacy rows whose
	 *  source conversation was gone when the 0006 recovery migration ran. */
	function enhancedPromptOf(m: MediaListItem): string | null {
		return m.promptFull ?? m.promptExcerpt;
	}

	const ACTION_BUTTON =
		'inline-flex items-center gap-1.5 rounded-md border border-media-border bg-media-surface px-3 py-1.5 text-xs font-medium text-media-fg transition hover:bg-media-surface-hover disabled:opacity-50';

	async function regenerateWith(m: MediaListItem, prompt: string | null) {
		// Skip silently if there is genuinely no prompt — the button shouldn't be
		// reachable then (it's absent, or held hidden and inert in a carousel), but
		// defense-in-depth.
		if (!prompt) return;
		stashIntent({
			kind: 'regenerate',
			prompt,
			sourceModelId: sourceModelIdFor(m),
			aspectRatio: m.aspectRatio,
		});
		onClose();
		await goto(resolve('/(app)'));
	}

	async function useAsStartingImage(m: MediaListItem) {
		// Videos aren't valid "starting" inputs in v1 — the existing
		// attachments pipeline is image-only. The button is hidden for
		// videos but defense-in-depth.
		if (m.kind !== 'image') return;
		stashIntent({
			kind: 'starting-image',
			mediaId: m.id,
			sourceModelId: sourceModelIdFor(m),
		});
		onClose();
		await goto(resolve('/(app)'));
	}

	// Whether to route saving through the native share sheet. iOS Safari
	// (incl. standalone PWAs) supports Web Share Level 2; that's the only
	// reliable "save to camera roll" path there — iOS ignores the
	// `<a download>` attribute and instead navigates the webview to the
	// asset, which in a home-screen PWA strands the user on Safari's Quick
	// Look preview with no way back.
	//
	// But macOS Safari ALSO supports Web Share with files, while having a
	// perfectly good direct download — there the share sheet is just extra
	// taps. So we additionally require a touch-primary device via
	// `(pointer: coarse)`: true on phones/tablets (incl. iOS PWAs), false
	// on a Mac with a trackpad/mouse.
	//
	// MediaQuery's `false` fallback is the SSR value, so the server renders the
	// Download icon. Unlike the one-shot matchMedia probe this replaces, it also
	// stays live: pairing a mouse to a tablet (or unpairing one) re-resolves both
	// flags instead of leaving them stuck at whatever was true when the lightbox
	// mounted.
	//
	// CAVEAT: the probe this replaced ran in a mount-deferred $effect specifically
	// so the client upgraded to Share AFTER hydration. A $derived resolves during
	// the hydration pass instead, which would be an `{#if}` structure mismatch —
	// but only if this component's `media`-gated subtree were ever server-rendered.
	// It isn't: every caller seeds `media`/`lightbox` to null and only fills it
	// from a click handler or an async fetch, so the gated markup never joins the
	// hydration walk. If you ever SSR the lightbox already open (a deep link
	// straight to a media item, say), move `coarsePointer`/`useShareSheet` back
	// behind a post-mount gate.
	const coarse = new MediaQuery('pointer: coarse', false);
	// Touch-primary devices already get swipe + scroll-snap; the on-image
	// arrow buttons are a desktop (mouse/trackpad) affordance, so we hide
	// them on coarse pointers to keep the image unobstructed there.
	const coarsePointer = $derived(coarse.current);
	// `coarse.current` first so the navigator probes are short-circuited away
	// during SSR, where `navigator` doesn't exist.
	const useShareSheet = $derived(
		coarse.current &&
			typeof navigator.canShare === 'function' &&
			typeof navigator.share === 'function',
	);

	// id of the media whose content is currently being fetched, used to
	// disable the button so a double-tap can't kick off two downloads.
	let savingId = $state<string | null>(null);

	function filenameFor(m: MediaListItem): string {
		// MediaListItem carries no original filename — the lightbox shows
		// generated images/videos — so we synthesize one. Shape is
		// `glyphstream-<localtimestamp>-<shortid>.<ext>`:
		//   - the `glyphstream-` prefix groups our exports together,
		//   - the local-time timestamp sorts chronologically (and is the
		//     part that survives into Files / desktop downloads),
		//   - an 8-char id fragment guarantees uniqueness within a second.
		// We deliberately avoid a prompt slug — booru-style prompts (quality
		// tags, repeated boilerplate) make for non-descriptive, duplicated
		// names. Extension is derived from the content type
		// (`image/svg+xml` → `svg`, `image/webp` → `webp`).
		const subtype = m.contentType.split('/')[1] ?? 'bin';
		const ext = subtype.split('+')[0];
		const shortId = m.id.replace(/-/g, '').slice(0, 8);
		return `glyphstream-${timestampSlug(m.createdAt)}-${shortId}.${ext}`;
	}

	// `YYYYMMDD-HHMMSS` in the viewer's local time. No colons (illegal in
	// filenames on most platforms); zero-padded so lexical sort === chrono
	// sort.
	function timestampSlug(ms: number): string {
		const d = new Date(ms);
		const p = (n: number) => String(n).padStart(2, '0');

		return (
			`${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}` +
			`-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
		);
	}

	/**
	 * Save the asset. Fetches the content to a Blob, then prefers the
	 * native share sheet (one tap → "Save Image" on iOS) when the platform
	 * supports file sharing, falling back to a blob-URL `<a download>` on
	 * desktop where the share API is absent but `download` works.
	 */
	async function shareOrDownload(m: MediaListItem) {
		savingId = m.id;
		try {
			const res = await fetch(`/api/media/${m.id}/content`);
			if (!res.ok) throw new Error(await errorMessageFromResponse(res));
			const blob = await res.blob();
			const filename = filenameFor(m);
			const file = new File([blob], filename, { type: m.contentType });

			if (useShareSheet && navigator.canShare?.({ files: [file] })) {
				try {
					await navigator.share({ files: [file] });
					return;
				} catch (err) {
					// User dismissed the sheet — nothing more to do.
					if (err instanceof Error && err.name === 'AbortError') return;
					// Any other share failure falls through to blob download.
				}
			}

			const url = URL.createObjectURL(blob);
			const a = document.createElement('a');
			a.href = url;
			a.download = filename;
			document.body.appendChild(a);
			a.click();
			a.remove();
			URL.revokeObjectURL(url);
		} catch {
			// Fetch/permission failure: last-resort plain navigation so the
			// button is never a dead end. (This is the one path that can
			// strand an iOS PWA user, but it only fires on network error.)
			window.location.href = `/api/media/${m.id}/content`;
		} finally {
			savingId = null;
		}
	}
</script>

<!-- An action caption that shortens below `sm`, so the action row fits one line
     on a phone. The caller puts `full` in aria-label too: both spans are in the
     DOM, and the accessible name shouldn't read both. -->
{#snippet caption(short: string, full: string)}
	<span class="sm:hidden">{short}</span><span class="hidden sm:inline">{full}</span>
{/snippet}

<svelte:window onkeydown={onKey} />

{#if media}
	{@const m = media}
	{@const hasPrompt = (m.promptFull ?? m.promptExcerpt) !== null}
	{@const canUseAsStarting = m.kind === 'image'}
	<!-- Images only: a video has no still to stand in for a preset, and the
	     avatar surfaces render an <img>. -->
	{@const canSetAvatar = m.kind === 'image' && !!onSetAvatar && avatarTargets.length > 0}
	<!-- Whether the action row holds each kind of slot (a carousel keeps one even
	     where it doesn't apply; see the row). -->
	{@const avatarSlot = canSetAvatar || (showCarousel && !!onSetAvatar && avatarTargets.length > 0)}
	{@const launchSlots = !trashed && (hasPrompt || canUseAsStarting || showCarousel)}
	<!-- Mid-swipe the star shows neither state: the old one would be a claim
	     about an image the user has left. -->
	{@const starred = m.favorite && !stale}
	<!-- svelte-ignore a11y_click_events_have_key_events a11y_interactive_supports_focus -->
	<div
		role="dialog"
		aria-modal="true"
		aria-label="Media preview"
		tabindex="-1"
		class="fixed inset-0 z-overlay flex flex-col bg-black/90 px-4 pt-[max(1rem,env(safe-area-inset-top))] pb-[max(1rem,env(safe-area-inset-bottom))] backdrop-blur"
		onclick={(e) => {
			// Backdrop-only close: ignore clicks that bubbled from a
			// child (the image, prompt text, conversation list, etc.).
			if (e.target === e.currentTarget) onClose();
		}}
	>
		<div
			class="flex shrink-0 items-center justify-between gap-3 pb-3 text-sm text-media-fg-secondary"
		>
			<div class="flex flex-col text-xs">
				<span class="font-medium">
					<!--
						`sourceModel` is a whole internal id (`bridge::comfyui/anima`),
						so it reads as plumbing unless the endpoint and owner prefixes
						come off — same label the gallery's model facet shows. Dropping
						the prefix collapses two endpoints serving one model to the same
						name, so the endpoint goes in the metadata line below, where it
						is readable everywhere. The `title` carries the whole id for a
						pointer, and only for a pointer — there is no tooltip on touch,
						which is most of this app's use.
					-->
					<span title={m.sourceModel ?? undefined}>
						{m.sourceModel ? friendlyModelName(m.sourceModel) : 'Unknown model'}
					</span>
					{#if showCarousel}
						<span class="ml-1 opacity-60 tabular-nums">{displayIndex + 1} / {siblings!.length}</span
						>
					{/if}
				</span>
				<span class="opacity-70">{metaLine(m)}</span>
			</div>
			<div class="flex gap-1.5">
				{#if onToggleFavorite}
					<!--
						Leads the toolbar: the cheapest, most repeatable action here, and
						the one a reviewing pass uses over and over. Unlike the picker's
						model star this one is always fully visible — it sits in a toolbar
						of peers rather than a list of rows, so there's no column of grey
						stars to keep quiet, and a `can-hover:` fade would make it
						unreachable on the touch devices this view is mostly used from.
					-->
					<button
						type="button"
						onclick={() => onToggleFavorite?.(m.id, !m.favorite)}
						disabled={stale || favoritingId !== null}
						title={starred ? 'Remove from favorites' : 'Add to favorites'}
						aria-label={starred ? 'Remove from favorites' : 'Add to favorites'}
						aria-pressed={starred}
						class="flex h-8 w-8 items-center justify-center rounded-md border border-media-border bg-media-surface transition hover:bg-media-surface-hover disabled:opacity-50 {starred
							? 'text-favorite'
							: 'text-media-fg-secondary'}"
					>
						<Star size={14} strokeWidth={2.25} fill={starred ? 'currentColor' : 'none'} />
					</button>
				{/if}
				{#if !trashed}
					<button
						type="button"
						onclick={() => shareOrDownload(m)}
						disabled={stale || savingId === m.id}
						title={useShareSheet ? 'Share / Save' : 'Download'}
						aria-label={useShareSheet ? 'Share or save' : 'Download'}
						class="flex h-8 w-8 items-center justify-center rounded-md border border-media-border bg-media-surface text-media-fg-secondary transition hover:bg-media-surface-hover disabled:opacity-50"
					>
						{#if useShareSheet}
							<Share size={14} strokeWidth={2.25} />
						{:else}
							<Download size={14} strokeWidth={2.25} />
						{/if}
					</button>
				{/if}
				{#if onRestore}
					<button
						type="button"
						onclick={() => onRestore?.(m.id)}
						disabled={stale || restoringId === m.id}
						title={restoringId === m.id ? 'Restoring…' : 'Restore'}
						aria-label="Restore"
						class="flex h-8 w-8 items-center justify-center rounded-md border border-media-border bg-media-surface text-media-fg-secondary transition hover:bg-media-surface-hover disabled:opacity-50"
					>
						<Undo2 size={14} strokeWidth={2.25} />
					</button>
				{/if}
				{#if onDelete}
					<button
						type="button"
						onclick={() => onDelete?.(m.id)}
						disabled={stale || deletingId === m.id}
						title={deletingId === m.id ? 'Deleting…' : 'Delete'}
						aria-label="Delete"
						class="flex h-8 w-8 items-center justify-center rounded-md btn-danger transition disabled:opacity-50"
					>
						<Trash2 size={14} strokeWidth={2.25} />
					</button>
				{/if}
				<button
					type="button"
					onclick={onClose}
					title="Close"
					aria-label="Close"
					class="flex h-8 w-8 items-center justify-center rounded-md border border-media-border bg-media-surface text-media-fg-secondary transition hover:bg-media-surface-hover"
				>
					<X size={14} strokeWidth={2.25} />
				</button>
			</div>
		</div>
		{#if showCarousel}
			<!--
				Carousel mode. A horizontal scroll-snap track is the whole
				gesture engine: native momentum swiping on touch, two-finger
				swipe on a trackpad, zero drag-tracking JS. Each slide is
				full-width and snap-centered; off-screen slides keep their
				<img loading="lazy"> so a long set doesn't fetch every
				original up front. `onTrackScroll` reports the slide a swipe
				is heading for back to the caller, which swaps `media`. Videos
				render with controls but NOT autoplay here (unlike the
				single-item view) — autoplaying the centered one as you swipe
				past others is more jarring than useful.
			-->
			<div class="relative flex flex-1 overflow-hidden">
				<!-- The touch handlers only watch for a finger lifting (passive, no
				     behaviour of their own) — the scroll is the interaction. -->
				<!-- svelte-ignore a11y_no_static_element_interactions -->
				<div
					bind:this={trackEl}
					onscroll={onTrackScroll}
					ontouchstart={onTrackTouchStart}
					ontouchend={onTrackTouchEnd}
					ontouchcancel={onTrackTouchEnd}
					class="flex flex-1 snap-x snap-mandatory overflow-x-auto overflow-y-hidden overscroll-x-contain [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
				>
					{#each siblings! as s, i (s.id)}
						<!--
							`snap-always` (scroll-snap-stop: always) is what makes a
							flick land on the *adjacent* slide and stop, instead of
							gliding several slides on momentum — without it a quick
							swipe coasts for ~a second before settling, which reads
							as sluggish. One swipe = one image, Instagram-style.
						-->
						<div
							class="flex w-full shrink-0 snap-center snap-always items-center justify-center px-1"
						>
							{#if !slideMounted(i)}
								<!--
									Out of window: an empty slot of the same width. The SLOT has
									to stay — the track is scroll-snap and `onTrackScroll` maps
									scroll offset back to an index, so slicing the array would
									shift every index and break both. Only the media is skipped.

									`siblings` is every unit demand-loaded this gallery session,
									so after a deep scroll this each-block was mounting thousands
									of full-resolution <img> at once. `loading="lazy"` keeps them
									from all being fetched, but they're still elements the browser
									must create, style and lay out on open.
								-->
							{:else if s.kind === 'video'}
								<!-- svelte-ignore a11y_media_has_caption -->
								<!--
									h-full w-full, not max-*: a <video> with no loaded data takes its
									INTRINSIC size from the poster, and preload="none" means there is
									no data until the user presses play. With only max-constraints
									inside an items-center flex parent, that laid the element out at
									the poster's own 512px — a small box in a full-screen overlay
									that snapped to full size on play (measured 512x288 -> 1408x792
									at 1440px wide, in both Chromium and WebKit). Pinning the box and
									letting object-contain letterbox the frame keeps the poster and
									removes the jump. The chat surface never had this because its
									w-full drives the width and the poster only supplies the ratio.

									Two consequences of pinning the box, both accepted: `rounded-lg`
									is dropped because it would round a transparent box rather than
									the frame, and the native controls sit at the bottom of that box
									rather than the picture — object-fit moves the content, not the
									element. Fixing the controls would need a wrapper sized from the
									media's real aspect ratio, which is more machinery than a
									letterbox gap against a black backdrop is worth.
								-->
								<video
									src="/api/media/{s.id}/content{bytesQuery}"
									poster="/api/media/{s.id}/thumbnail{bytesQuery}"
									controls
									playsinline
									preload="none"
									class="h-full w-full object-contain"
								></video>
							{:else}
								<!--
									The slide being LOOKED AT loads eagerly at high priority; its
									neighbours stay lazy so they're ready on a swipe without
									competing. Marking the current one `lazy` too meant every open
									and every arrow press waited a full round trip on a blank
									slide, because the browser only starts the fetch once the
									element is near the viewport.
								-->
								<img
									src="/api/media/{s.id}/content{bytesQuery}"
									alt={s.id === m.id ? (m.promptExcerpt ?? 'Generated image') : ''}
									loading={i === currentIndex ? 'eager' : 'lazy'}
									fetchpriority={i === currentIndex ? 'high' : 'low'}
									class="max-h-full max-w-full rounded-lg object-contain"
								/>
							{/if}
						</div>
					{/each}
				</div>
				{#if !coarsePointer}
					<button
						type="button"
						onclick={() => navigate(-1)}
						disabled={displayIndex <= 0}
						aria-label="Previous"
						title="Previous"
						class="absolute left-1 top-1/2 flex h-10 w-10 -translate-y-1/2 items-center justify-center rounded-full bg-black/40 text-media-fg transition hover:bg-black/60 disabled:pointer-events-none disabled:opacity-0"
					>
						<ChevronLeft size={22} strokeWidth={2.25} />
					</button>
					<button
						type="button"
						onclick={() => navigate(1)}
						disabled={displayIndex >= siblings!.length - 1}
						aria-label="Next"
						title="Next"
						class="absolute right-1 top-1/2 flex h-10 w-10 -translate-y-1/2 items-center justify-center rounded-full bg-black/40 text-media-fg transition hover:bg-black/60 disabled:pointer-events-none disabled:opacity-0"
					>
						<ChevronRight size={22} strokeWidth={2.25} />
					</button>
				{/if}
			</div>
		{:else}
			<div class="flex flex-1 items-center justify-center overflow-hidden">
				{#if m.kind === 'image'}
					<img
						src="/api/media/{m.id}/content{bytesQuery}"
						alt={m.promptExcerpt ?? 'Generated image'}
						class="max-h-full max-w-full rounded-lg object-contain"
					/>
				{:else}
					<!-- svelte-ignore a11y_media_has_caption -->
					<video
						src="/api/media/{m.id}/content{bytesQuery}"
						controls
						autoplay
						playsinline
						class="max-h-full max-w-full rounded-lg"
					></video>
				{/if}
			</div>
		{/if}
		{#if m.promptExcerpt || showCarousel}
			<!--
				In carousel mode the strip keeps the same height whatever the prompt:
				three lines (the clamp, so never more) plus the toggle's line, even for
				a short prompt or none. The track above is flex-1, so a strip that grew
				and shrank with each prompt resized the image — and a swipe swaps this
				at its midpoint, while the slide is still moving. The width is capped,
				so a long prompt wraps to the same three lines at every screen size.
				Only the user-opened original prompt still adds height.
			-->
			<div data-testid="lightbox-prompt" class="mx-auto mt-3 w-full max-w-3xl shrink-0 text-center">
				<p class="text-xs text-media-fg-muted line-clamp-3 {showCarousel ? 'min-h-[3lh]' : ''}">
					{m.promptExcerpt ?? ''}
				</p>
				{#if m.originalPrompt || showCarousel}
					<!-- The shown prompt is the enhanced one (what generated the image).
					     Offer the user's original behind a toggle. Held in place, hidden,
					     for a carousel slide without one. -->
					<button
						type="button"
						class="mt-1 text-[11px] text-media-fg-subtle underline decoration-dotted underline-offset-2 hover:text-media-fg-secondary {m.originalPrompt
							? ''
							: 'invisible'}"
						disabled={stale || !m.originalPrompt}
						onclick={() => (showOriginal = !showOriginal)}
						>{showOriginal ? 'Hide original' : 'Enhanced — show original'}</button
					>

					{#if showOriginal && m.originalPrompt}
						<p class="mt-1 text-xs text-media-fg-subtle italic line-clamp-4">
							{m.originalPrompt}
						</p>
					{/if}
				{/if}
			</div>
		{/if}
		{#if avatarSlot || launchSlots}
			<!--
				The act-on-this-image actions, in ONE row: "Regenerate" and "Edit" send
				the user to / pre-loaded with the relevant intent (see the LAUNCH_KEY
				pattern at the top of this file); "Set as avatar" is the cheapest path
				to a preset portrait (generate however you like, including a fan-out of
				variants, then keep the one you want). They sit just below the prompt
				strip so they read as actions *on* the prompt and image — the top
				toolbar is reserved for share/delete/close.

				Sized to fit one line on a phone: below `sm` each button shows a short
				caption (the full one stays the accessible name), and the enhanced
				prompt's two regenerate choices share one button behind a menu. In a
				carousel every slot holds its place, hidden and inert, on a slide where
				it doesn't apply (a video can't be an avatar or an edit source; an
				upload has no prompt). This row used to be two rows whose button count
				varied per slide, so wrapping changed the height and resized the image
				mid-swipe — same reason as the prompt strip.
			-->
			<div class="mx-auto mt-3 flex shrink-0 flex-wrap justify-center gap-2">
				{#if launchSlots && (hasPrompt || showCarousel)}
					{@const regenLabel = inConversation
						? 'Regenerate in a new chat'
						: 'Regenerate with this prompt'}
					{#if m.originalPrompt}
						<!-- The prompt was enhanced, so offer both: regenerate from the
						     user's ORIGINAL (re-enhances fresh) or from the EXACT enhanced
						     prompt that made this image. -->
						<Popover.Root>
							<Popover.Trigger
								disabled={stale}
								aria-label="{regenLabel}…"
								title="Start a new conversation from your original or the enhanced prompt"
								class={ACTION_BUTTON}
							>
								<RotateCcw size={13} strokeWidth={2.25} />
								{@render caption('Regenerate…', `${regenLabel}…`)}
							</Popover.Trigger>
							<Popover.Portal>
								<Popover.Content
									sideOffset={4}
									class="z-overlay w-64 rounded-md border border-border surface-glass gs-pop p-1 shadow-lg"
								>
									<!-- The items carry the trigger's `stale` guard too: an open menu
									     stays open across an arrow-key move to another enhanced slide,
									     and mid-swipe `m` is still the image the user left, not the
									     slide now on screen. -->
									<p
										class="px-2 py-1.5 text-[11px] font-medium uppercase tracking-wide text-fg-muted"
									>
										Regenerate from
									</p>
									<button
										type="button"
										onclick={() => regenerateWith(m, m.originalPrompt)}
										disabled={stale}
										class="flex w-full flex-col rounded px-2 py-1.5 text-left text-xs transition hover:bg-surface-sunken disabled:opacity-60"
									>
										Your original prompt
										<span class="text-[11px] text-fg-muted">Enhanced again for the model</span>
									</button>
									<button
										type="button"
										onclick={() => regenerateWith(m, enhancedPromptOf(m))}
										disabled={stale}
										class="flex w-full flex-col rounded px-2 py-1.5 text-left text-xs transition hover:bg-surface-sunken disabled:opacity-60"
									>
										The enhanced prompt
										<span class="text-[11px] text-fg-muted">Exactly what made this image</span>
									</button>
								</Popover.Content>
							</Popover.Portal>
						</Popover.Root>
					{:else}
						<button
							type="button"
							onclick={() => regenerateWith(m, enhancedPromptOf(m))}
							disabled={stale || !hasPrompt}
							inert={!hasPrompt}
							aria-label={regenLabel}
							title="Start a new conversation pre-filled with this prompt"
							class="{ACTION_BUTTON} {hasPrompt ? '' : 'invisible'}"
						>
							<RotateCcw size={13} strokeWidth={2.25} />
							{@render caption('Regenerate', regenLabel)}
						</button>
					{/if}
				{/if}
				{#if launchSlots && (canUseAsStarting || showCarousel)}
					{@const editLabel = inConversation ? 'Edit in a new chat' : 'Use as starting image'}
					<button
						type="button"
						onclick={() => useAsStartingImage(m)}
						disabled={stale || !canUseAsStarting}
						inert={!canUseAsStarting}
						aria-label={editLabel}
						title="Start a new conversation with this image attached"
						class="{ACTION_BUTTON} {canUseAsStarting ? '' : 'invisible'}"
					>
						<ImagePlus size={13} strokeWidth={2.25} />
						{@render caption('Edit', editLabel)}
					</button>
				{/if}
				{#if avatarSlot}
					<!-- `invisible` inherits through `contents`, so this hides the button
					     without the wrapper taking a place of its own in the row. -->
					<div class="contents {canSetAvatar ? '' : 'invisible'}" inert={!canSetAvatar}>
						{#if avatarTargets.length === 1}
							<!-- One preset: a menu to choose between one option is a wasted
							     click, so name it in the button instead. -->
							{@const only = avatarTargets[0]}
							{@const current = only.avatarMediaId === m.id}
							{@const avatarLabel = current
								? `Avatar for ${only.name}`
								: `Set as avatar for ${only.name}`}
							<button
								type="button"
								disabled={stale || settingAvatar || current}
								onclick={() => onSetAvatar?.({ kind: only.kind, id: only.id }, m.id)}
								aria-label={avatarLabel}
								title={current
									? `Already ${only.name}'s avatar`
									: `Show this image beside ${only.name}'s replies`}
								class={ACTION_BUTTON}
							>
								<!-- The short caption drops the name, so the check carries
								     "already" on a phone. -->
								{#if current}
									<Check size={13} strokeWidth={2.25} />
								{:else}
									<UserRound size={13} strokeWidth={2.25} />
								{/if}
								{@render caption(current ? 'Avatar' : 'Set avatar', avatarLabel)}
							</button>
						{:else}
							<Popover.Root>
								<Popover.Trigger
									disabled={stale || settingAvatar}
									aria-label="Set as avatar…"
									title="Show this image beside a preset's replies"
									class={ACTION_BUTTON}
								>
									<UserRound size={13} strokeWidth={2.25} />
									{@render caption('Set avatar…', 'Set as avatar…')}
								</Popover.Trigger>
								<Popover.Portal>
									<Popover.Content
										sideOffset={4}
										class="z-overlay max-h-72 w-64 overflow-y-auto rounded-md border border-border surface-glass gs-pop p-1 shadow-lg"
									>
										<p
											class="px-2 py-1.5 text-[11px] font-medium uppercase tracking-wide text-fg-muted"
										>
											Set as avatar for
										</p>
										{#each avatarTargets as t (t.kind + ':' + t.id)}
											{@const current = t.avatarMediaId === m.id}
											<button
												type="button"
												disabled={settingAvatar || current}
												onclick={() => onSetAvatar?.({ kind: t.kind, id: t.id }, m.id)}
												class="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs transition hover:bg-surface-sunken disabled:opacity-60"
											>
												{#if t.avatarMediaId}
													<img
														src="/api/media/{t.avatarMediaId}/thumbnail"
														alt=""
														loading="lazy"
														class="size-5 shrink-0 rounded-full object-cover"
													/>
												{:else}
													<span
														class="size-5 shrink-0 rounded-full border border-dashed border-border-strong"
													></span>
												{/if}
												<span class="min-w-0 flex-1 truncate">{t.name}</span>
												{#if current}
													<Check size={13} strokeWidth={2.25} class="shrink-0 text-fg-muted" />
												{/if}
											</button>
										{/each}
									</Popover.Content>
								</Popover.Portal>
							</Popover.Root>
						{/if}
					</div>
				{/if}
			</div>
		{/if}
		{#if conversationsUsingThis !== undefined}
			<div class="mx-auto mt-3 w-full max-w-3xl shrink-0 text-xs text-media-fg-muted">
				{#if conversationsUsingThis === null}
					<p class="text-center opacity-60">Loading conversations…</p>
				{:else if conversationsError}
					<p class="text-center text-red-300">{conversationsError}</p>
				{:else if conversationsUsingThis.length === 0}
					<p class="text-center opacity-60">Not used in any conversation.</p>
				{:else if conversationsUsingThis.length === 1}
					<!--
						Common case: a generated asset lives in exactly one
						conversation. Render it as a single inline link rather
						than a "Used in 1 conversation:" header over a one-item
						list — the header/list scaffolding only earns its keep
						when there's more than one to enumerate. Multi-reference
						is still reachable (the same media id reused as a
						"starting image" in other chats), handled by the N>1
						branch below.
					-->
					{@const c = conversationsUsingThis[0]}
					<p class="text-center">
						<span class="opacity-60">In conversation: </span>
						<a
							href={resolve(`chat/${c.id}`)}
							class="inline-block max-w-full truncate align-bottom text-media-fg-secondary underline decoration-media-border underline-offset-2 hover:decoration-media-fg-muted"
						>
							{c.title ?? 'Untitled'}
						</a>
						{#if c.archivedAt !== null}
							<span class="ml-1 text-[10px] uppercase tracking-wide opacity-60">archived</span>
						{/if}
					</p>
				{:else}
					<div class="text-center opacity-60">
						Used in {conversationsUsingThis.length} conversations:
					</div>
					<ul class="mx-auto mt-1 flex max-h-32 flex-col gap-0.5 overflow-y-auto">
						{#each conversationsUsingThis as c (c.id)}
							<li>
								<a
									href={resolve(`chat/${c.id}`)}
									class="block truncate rounded px-2 py-1 text-center text-media-fg-secondary hover:bg-media-surface"
								>
									{c.title ?? 'Untitled'}
									{#if c.archivedAt !== null}
										<span class="ml-1 text-[10px] uppercase tracking-wide opacity-60">
											archived
										</span>
									{/if}
								</a>
							</li>
						{/each}
					</ul>
				{/if}
			</div>
		{/if}
	</div>
{/if}
