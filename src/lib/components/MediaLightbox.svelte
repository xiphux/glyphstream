<script lang="ts">
	import { goto } from '$app/navigation';
	import {
		ChevronLeft,
		ChevronRight,
		Download,
		ImagePlus,
		RotateCcw,
		Share,
		Trash2,
		X,
	} from '@lucide/svelte';
	import type { MediaConversationRef, MediaKind, MediaListItem } from '$lib/types/api';
	import { GALLERY_LAUNCH_KEY, type GalleryLaunchIntent } from '$lib/gallery-launch';

	interface Props {
		/** The media being shown; null means the lightbox is closed (renders nothing). */
		media: MediaListItem | null;
		/** Called when the user closes via Escape, the X button, or backdrop click. */
		onClose: () => void;
		/**
		 * Optional Delete action. Gallery wires this up; in-conversation
		 * tap doesn't (the conversation surface has its own message-level
		 * controls, and exposing destructive media deletion from inside a
		 * chat is the wrong context).
		 */
		onDelete?: (id: string) => void | Promise<void>;
		/** Media id currently being deleted, used to disable the delete button. */
		deletingId?: string | null;
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
		siblings?: { id: string; kind: MediaKind }[];
		/**
		 * Called when the user swipes / clicks an arrow / presses an arrow
		 * key to move to a different sibling. The caller resolves the id to
		 * a full MediaListItem and feeds it back in via `media` (gallery has
		 * it in memory; chat fetches it). Required for navigation to do
		 * anything — without it the carousel is inert.
		 */
		onNavigate?: (id: string) => void;
	}

	let {
		media,
		onClose,
		onDelete,
		deletingId = null,
		conversationsUsingThis = undefined,
		conversationsError = null,
		inConversation = false,
		siblings = undefined,
		onNavigate = undefined,
	}: Props = $props();

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

	// Swipe handler: after the scroll settles, snap the open item to
	// whichever slide the user landed on. Debounced because `scroll` fires
	// continuously during an inertial swipe — we only want the resting
	// slide, and (for the chat caller) one resolve fetch, not one per slide
	// flown past.
	let scrollSettleTimer: ReturnType<typeof setTimeout> | undefined;
	function onTrackScroll() {
		const el = trackEl;
		if (!el || !siblings) return;
		// Track the live position while scrolling, not just on settle — that's what
		// keeps the slides being scrolled through mounted.
		//
		// Quantized to SLIDE_WINDOW steps rather than written per crossed slide.
		// `slideMounted` is called inside the per-item `{#if}` of an each-block
		// over every unit loaded this gallery session (thousands after a deep
		// scroll), so in Svelte 5 every sibling's block effect subscribes to this
		// one `$state`. Writing it per slide re-runs all of them per slide; at this
		// granularity the mounted set only shifts when the position has moved far
		// enough to actually change it.
		if (el.clientWidth > 0) {
			const idx = Math.round(el.scrollLeft / el.clientWidth);
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
			if (landed.id === media?.id) {
				// Settled back on what's already shown — so anything still queued is
				// stale, and letting it fire would drag `media` away from the slide the
				// user is looking at. Reachable by arrowing forward (leaving a trailing
				// resolve armed) and swiping back inside the same window.
				clearTimeout(navResolveTimer);
				pendingIndex = null;
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
		if (el) el.scrollTo({ left: next * el.clientWidth, behavior: 'smooth' });
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
			onNavigate?.(id);
			return;
		}
		navResolveTimer = setTimeout(() => {
			navResolveBlockedUntil = Date.now() + NAV_RESOLVE_WINDOW_MS;
			const target = pendingIndex !== null ? siblings?.[pendingIndex]?.id : undefined;
			onNavigate?.(target ?? id);
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
	});
	// And on teardown, for callers that do unmount it.
	$effect(() => () => {
		clearTimeout(navResolveTimer);
		clearTimeout(scrollSettleTimer);
	});

	function fmtBytes(n: number): string {
		if (n < 1024) return `${n} B`;
		if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
		return `${(n / (1024 * 1024)).toFixed(1)} MB`;
	}

	function fmtDate(ms: number): string {
		return new Date(ms).toLocaleString();
	}

	// Escape-to-close lives on window so it works regardless of focus —
	// the lightbox is intentionally a tabindex=-1 dialog (not a focus
	// trap) so the Escape semantic needs to be global. Early-return when
	// no media is open so unrelated keypresses don't reach onClose.
	function onKey(e: KeyboardEvent) {
		if (!media) return;
		if (e.key === 'Escape') {
			onClose();
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
		// Compose the internal `endpointId::upstreamId` form the model
		// picker uses. If either piece is missing (legacy uploads, or
		// generations from before the source-model fields were captured)
		// return null and let the new-chat page pick its own default.
		if (!m.sourceEndpointId || !m.sourceModel) return null;
		return `${m.sourceEndpointId}::${m.sourceModel}`;
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

	async function regenerateWith(m: MediaListItem, prompt: string | null) {
		// Skip silently if there is genuinely no prompt — the button shouldn't
		// render in that case, but defense-in-depth.
		if (!prompt) return;
		stashIntent({
			kind: 'regenerate',
			prompt,
			sourceModelId: sourceModelIdFor(m),
		});
		onClose();
		await goto('/');
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
		await goto('/');
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
	// on a Mac with a trackpad/mouse. Detected in an effect (not at module
	// scope) so SSR renders the Download icon and the client upgrades to
	// Share without a hydration mismatch.
	let useShareSheet = $state(false);
	// Touch-primary devices already get swipe + scroll-snap; the on-image
	// arrow buttons are a desktop (mouse/trackpad) affordance, so we hide
	// them on coarse pointers to keep the image unobstructed there. Same
	// `(pointer: coarse)` probe as the share-sheet decision.
	let coarsePointer = $state(false);
	$effect(() => {
		const apiSupported =
			typeof navigator !== 'undefined' &&
			typeof navigator.canShare === 'function' &&
			typeof navigator.share === 'function';
		const touchPrimary = window.matchMedia?.('(pointer: coarse)').matches ?? false;
		useShareSheet = apiSupported && touchPrimary;
		coarsePointer = touchPrimary;
	});

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
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
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

<svelte:window onkeydown={onKey} />

{#if media}
	{@const m = media}
	{@const hasPrompt = (m.promptFull ?? m.promptExcerpt) !== null}
	{@const canUseAsStarting = m.kind === 'image'}
	<!-- svelte-ignore a11y_click_events_have_key_events a11y_interactive_supports_focus -->
	<div
		role="dialog"
		aria-modal="true"
		aria-label="Media preview"
		tabindex="-1"
		class="fixed inset-0 z-50 flex flex-col bg-black/90 px-4 pt-[max(1rem,env(safe-area-inset-top))] pb-[max(1rem,env(safe-area-inset-bottom))] backdrop-blur"
		onclick={(e) => {
			// Backdrop-only close: ignore clicks that bubbled from a
			// child (the image, prompt text, conversation list, etc.).
			if (e.target === e.currentTarget) onClose();
		}}
	>
		<div class="flex shrink-0 items-center justify-between gap-3 pb-3 text-sm text-neutral-200">
			<div class="flex flex-col text-xs">
				<span class="font-medium">
					{m.sourceModel ?? 'Unknown model'}
					{#if showCarousel}
						<span class="ml-1 opacity-60 tabular-nums">
							{displayIndex + 1} / {siblings!.length}
						</span>
					{/if}
				</span>
				<span class="opacity-70">
					{fmtDate(m.createdAt)} · {fmtBytes(m.byteSize)} · {m.contentType}
				</span>
			</div>
			<div class="flex gap-1.5">
				<button
					type="button"
					onclick={() => shareOrDownload(m)}
					disabled={savingId === m.id}
					title={useShareSheet ? 'Share / Save' : 'Download'}
					aria-label={useShareSheet ? 'Share or save' : 'Download'}
					class="flex h-8 w-8 items-center justify-center rounded-md border border-neutral-600 bg-neutral-800 text-neutral-200 transition hover:bg-neutral-700 disabled:opacity-50"
				>
					{#if useShareSheet}
						<Share size={14} strokeWidth={2.25} />
					{:else}
						<Download size={14} strokeWidth={2.25} />
					{/if}
				</button>
				{#if onDelete}
					<button
						type="button"
						onclick={() => onDelete?.(m.id)}
						disabled={deletingId === m.id}
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
					class="flex h-8 w-8 items-center justify-center rounded-md border border-neutral-600 bg-neutral-800 text-neutral-200 transition hover:bg-neutral-700"
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
				original up front. `onTrackScroll` (debounced) reports the
				rested slide back to the caller, which swaps `media`. Videos
				render with controls but NOT autoplay here (unlike the
				single-item view) — autoplaying the centered one as you swipe
				past others is more jarring than useful.
			-->
			<div class="relative flex flex-1 overflow-hidden">
				<div
					bind:this={trackEl}
					onscroll={onTrackScroll}
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
								<video
									src="/api/media/{s.id}/content"
									controls
									playsinline
									preload="metadata"
									class="max-h-full max-w-full rounded-lg"
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
									src="/api/media/{s.id}/content"
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
						class="absolute left-1 top-1/2 flex h-10 w-10 -translate-y-1/2 items-center justify-center rounded-full bg-black/40 text-neutral-100 transition hover:bg-black/60 disabled:pointer-events-none disabled:opacity-0"
					>
						<ChevronLeft size={22} strokeWidth={2.25} />
					</button>
					<button
						type="button"
						onclick={() => navigate(1)}
						disabled={displayIndex >= siblings!.length - 1}
						aria-label="Next"
						title="Next"
						class="absolute right-1 top-1/2 flex h-10 w-10 -translate-y-1/2 items-center justify-center rounded-full bg-black/40 text-neutral-100 transition hover:bg-black/60 disabled:pointer-events-none disabled:opacity-0"
					>
						<ChevronRight size={22} strokeWidth={2.25} />
					</button>
				{/if}
			</div>
		{:else}
			<div class="flex flex-1 items-center justify-center overflow-hidden">
				{#if m.kind === 'image'}
					<img
						src="/api/media/{m.id}/content"
						alt={m.promptExcerpt ?? 'Generated image'}
						class="max-h-full max-w-full rounded-lg object-contain"
					/>
				{:else}
					<!-- svelte-ignore a11y_media_has_caption -->
					<video
						src="/api/media/{m.id}/content"
						controls
						autoplay
						playsinline
						class="max-h-full max-w-full rounded-lg"
					></video>
				{/if}
			</div>
		{/if}
		{#if m.promptExcerpt}
			<div class="mx-auto mt-3 max-w-3xl shrink-0 text-center">
				<p class="text-xs text-neutral-300 line-clamp-3">
					{m.promptExcerpt}
				</p>
				{#if m.originalPrompt}
					<!-- The shown prompt is the enhanced one (what generated the image).
					     Offer the user's original behind a toggle. -->
					<button
						type="button"
						class="mt-1 text-[11px] text-neutral-400 underline decoration-dotted underline-offset-2 hover:text-neutral-200"
						onclick={() => (showOriginal = !showOriginal)}
					>
						{showOriginal ? 'Hide original' : 'Enhanced — show original'}
					</button>
					{#if showOriginal}
						<p class="mt-1 text-xs text-neutral-400 italic line-clamp-4">
							{m.originalPrompt}
						</p>
					{/if}
				{/if}
			</div>
		{/if}
		{#if hasPrompt || canUseAsStarting}
			<!--
				Gallery-launch actions: "Regenerate with this prompt" and
				"Use as starting image" send the user to / pre-loaded with
				the relevant intent (see the LAUNCH_KEY pattern at the top
				of this file). Sit just below the prompt strip so they
				read as actions *on* the prompt and image, not generic
				toolbar buttons — placement matters when the dialog is
				dense. Hidden when there's nothing meaningful to launch
				with (no prompt and not an image).
			-->
			<div class="mx-auto mt-3 flex shrink-0 flex-wrap justify-center gap-2">
				{#if hasPrompt}
					{#if m.originalPrompt}
						<!-- The prompt was enhanced, so offer both: regenerate from the
						     user's ORIGINAL (re-enhances fresh) or from the EXACT enhanced
						     prompt that made this image. -->
						<button
							type="button"
							onclick={() => regenerateWith(m, m.originalPrompt)}
							title="Start a new conversation from your original prompt (it will be enhanced again)"
							class="inline-flex items-center gap-1.5 rounded-md border border-neutral-600 bg-neutral-800 px-3 py-1.5 text-xs font-medium text-neutral-100 transition hover:bg-neutral-700"
						>
							<RotateCcw size={13} strokeWidth={2.25} />
							Regenerate (original)
						</button>
						<button
							type="button"
							onclick={() => regenerateWith(m, enhancedPromptOf(m))}
							title="Start a new conversation from the exact enhanced prompt that made this image"
							class="inline-flex items-center gap-1.5 rounded-md border border-neutral-600 bg-neutral-800 px-3 py-1.5 text-xs font-medium text-neutral-100 transition hover:bg-neutral-700"
						>
							<RotateCcw size={13} strokeWidth={2.25} />
							Regenerate (enhanced)
						</button>
					{:else}
						<button
							type="button"
							onclick={() => regenerateWith(m, enhancedPromptOf(m))}
							title="Start a new conversation pre-filled with this prompt"
							class="inline-flex items-center gap-1.5 rounded-md border border-neutral-600 bg-neutral-800 px-3 py-1.5 text-xs font-medium text-neutral-100 transition hover:bg-neutral-700"
						>
							<RotateCcw size={13} strokeWidth={2.25} />
							{inConversation ? 'Regenerate in a new chat' : 'Regenerate with this prompt'}
						</button>
					{/if}
				{/if}
				{#if canUseAsStarting}
					<button
						type="button"
						onclick={() => useAsStartingImage(m)}
						title="Start a new conversation with this image attached"
						class="inline-flex items-center gap-1.5 rounded-md border border-neutral-600 bg-neutral-800 px-3 py-1.5 text-xs font-medium text-neutral-100 transition hover:bg-neutral-700"
					>
						<ImagePlus size={13} strokeWidth={2.25} />
						{inConversation ? 'Edit in a new chat' : 'Use as starting image'}
					</button>
				{/if}
			</div>
		{/if}
		{#if conversationsUsingThis !== undefined}
			<div class="mx-auto mt-3 w-full max-w-3xl shrink-0 text-xs text-neutral-300">
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
							href="/chat/{c.id}"
							class="inline-block max-w-full truncate align-bottom text-neutral-200 underline decoration-neutral-600 underline-offset-2 hover:decoration-neutral-300"
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
									href="/chat/{c.id}"
									class="block truncate rounded px-2 py-1 text-center text-neutral-200 hover:bg-neutral-800"
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
