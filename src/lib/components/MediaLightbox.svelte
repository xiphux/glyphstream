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
	import type {
		MediaConversationRef,
		MediaKind,
		MediaListItem,
	} from '$lib/server/db/queries/media';
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
		 *  - `[]`: render "Not used in any conversation" (safe-to-delete signal).
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

	let trackEl = $state<HTMLDivElement | null>(null);

	// True once we've performed the initial (instant) scroll-to-position
	// for the current open session, so subsequent arrow/key moves animate.
	// Reset whenever the lightbox closes (media → null).
	let hasPositioned = false;
	$effect(() => {
		if (!media) hasPositioned = false;
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
		clearTimeout(scrollSettleTimer);
		scrollSettleTimer = setTimeout(() => {
			const idx = Math.round(el.scrollLeft / el.clientWidth);
			const landed = siblings[idx];
			if (landed && landed.id !== media?.id) onNavigate?.(landed.id);
		}, 90);
	}

	function navigate(delta: number) {
		if (!siblings || currentIndex < 0) return;
		const next = currentIndex + delta;
		if (next < 0 || next >= siblings.length) return;
		// Scroll immediately for instant feedback rather than waiting for the
		// metadata fetch (chat) to round-trip through `media` → currentIndex →
		// the positioning effect. The effect then no-ops (already centered).
		const el = trackEl;
		if (el) el.scrollTo({ left: next * el.clientWidth, behavior: 'smooth' });
		onNavigate?.(siblings[next].id);
	}

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

	async function regenerateWithPrompt(m: MediaListItem) {
		// promptFull is the primary source; falls back to promptExcerpt
		// for legacy rows whose source conversation was already gone
		// when the 0006 recovery migration ran. Skip silently if there
		// is genuinely no prompt — the button shouldn't render in that
		// case but defense-in-depth.
		const prompt = m.promptFull ?? m.promptExcerpt;
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
							{currentIndex + 1} / {siblings!.length}
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
					{#each siblings! as s (s.id)}
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
							{#if s.kind === 'video'}
								<!-- svelte-ignore a11y_media_has_caption -->
								<video
									src="/api/media/{s.id}/content"
									controls
									playsinline
									preload="metadata"
									class="max-h-full max-w-full rounded-lg"
								></video>
							{:else}
								<img
									src="/api/media/{s.id}/content"
									alt={s.id === m.id ? (m.promptExcerpt ?? 'Generated image') : ''}
									loading="lazy"
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
						disabled={currentIndex <= 0}
						aria-label="Previous"
						title="Previous"
						class="absolute left-1 top-1/2 flex h-10 w-10 -translate-y-1/2 items-center justify-center rounded-full bg-black/40 text-neutral-100 transition hover:bg-black/60 disabled:pointer-events-none disabled:opacity-0"
					>
						<ChevronLeft size={22} strokeWidth={2.25} />
					</button>
					<button
						type="button"
						onclick={() => navigate(1)}
						disabled={currentIndex >= siblings!.length - 1}
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
			<p class="mx-auto mt-3 max-w-3xl shrink-0 text-center text-xs text-neutral-300 line-clamp-3">
				{m.promptExcerpt}
			</p>
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
					<button
						type="button"
						onclick={() => regenerateWithPrompt(m)}
						title="Start a new conversation pre-filled with this prompt"
						class="inline-flex items-center gap-1.5 rounded-md border border-neutral-600 bg-neutral-800 px-3 py-1.5 text-xs font-medium text-neutral-100 transition hover:bg-neutral-700"
					>
						<RotateCcw size={13} strokeWidth={2.25} />
						{inConversation ? 'Regenerate in a new chat' : 'Regenerate with this prompt'}
					</button>
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
					<p class="text-center opacity-60">Not used in any conversation — safe to delete.</p>
				{:else}
					<div class="text-center opacity-60">
						Used in {conversationsUsingThis.length}
						{conversationsUsingThis.length === 1 ? 'conversation' : 'conversations'}:
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
