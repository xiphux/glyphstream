<script lang="ts">
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import MediaLightbox from '$lib/components/MediaLightbox.svelte';
	import { confirmDialog } from '$lib/confirm.svelte';
	import { observeSentinel } from '$lib/observe-sentinel';
	import type {
		MediaConversationRef,
		MediaListItem,
		MediaListResult,
	} from '$lib/server/db/queries/media';

	let { data } = $props<{ data: { initial: MediaListResult; kind: 'image' | 'video' | null } }>();

	// We seed local state from the SSR initial page, then mutate as the user
	// paginates / filters / deletes. The $effect below resyncs whenever
	// SvelteKit re-runs `load` (e.g. on filter switch via query-string nav).
	// svelte-ignore state_referenced_locally
	let items = $state<MediaListItem[]>([...data.initial.items]);
	// svelte-ignore state_referenced_locally
	let nextCursor = $state<string | null>(data.initial.nextCursor);
	let loadingMore = $state(false);
	// Two independent failure channels. `loadError` is pagination-only — it
	// gates the auto-load $effect and the Retry button, so a failed page
	// fetch stops the retry-loop without disabling anything else. `error` is
	// for delete failures (single + bulk); keeping it separate means a failed
	// delete shows its banner but does NOT wedge infinite scroll (which a
	// single shared channel did — there's no "Load more" fallback anymore).
	let loadError = $state<string | null>(null);
	let error = $state<string | null>(null);
	// Bumped every time SvelteKit re-runs `load` (i.e. a filter switch). A
	// loadMore() response that lands after a bump belongs to the previous
	// filter; it's discarded rather than concatenated onto — and clobbering
	// the cursor of — the freshly-loaded list.
	let loadGeneration = 0;
	let lightbox = $state<MediaListItem | null>(null);
	let deletingId = $state<string | null>(null);

	// Infinite-scroll plumbing. `scrollContainer` is the scrollable region used
	// as the IntersectionObserver root; `sentinel` is a zero-content marker
	// rendered just past the grid. `sentinelVisible` is the observer's output —
	// an $effect below turns it into auto-pagination.
	let scrollContainer = $state<HTMLElement | null>(null);
	let sentinel = $state<HTMLElement | null>(null);
	let sentinelVisible = $state(false);

	// Selection mode + selection set for bulk-delete. SvelteKit's reactivity
	// on collections needs a fresh reference to fire, so toggle/clear rebuild
	// the Set rather than mutating in place.
	let selectMode = $state(false);
	let selected = $state<Set<string>>(new Set());
	let bulkDeleting = $state(false);
	const selectedCount = $derived(selected.size);

	// Conversation refs for the currently-open lightbox item.
	// `null` means "we haven't fetched yet (loading)"; `[]` means "fetched,
	// genuinely none" — distinguishing these matters because the empty case
	// is the actual signal we want users to see ("you can clean up the
	// orphan media without breaking any chats").
	let lightboxConversations = $state<MediaConversationRef[] | null>(null);
	let conversationsError = $state<string | null>(null);

	// Refetch whenever a different lightbox item opens. Tracking by id
	// (not the whole object) avoids duplicate fetches when the list
	// re-renders and produces a new MediaListItem reference for the same row.
	$effect(() => {
		const id = lightbox?.id;
		if (!id) {
			lightboxConversations = null;
			conversationsError = null;
			return;
		}
		// Deliberately do NOT blank `lightboxConversations` here on navigate.
		// Resetting to null flashes the one-line "Loading…" placeholder
		// between every swipe, and that collapse-then-expand resizes the
		// flex-1 image area — a visible jerk after each carousel move. The
		// stale-id guard below already discards a late response, so keeping
		// the previous item's list visible during the ~one-fetch window is
		// safe; it's replaced atomically when the new list lands. On the
		// very first open the prior value is already null (cleared on close),
		// so the loading state still shows then, where it belongs.
		conversationsError = null;
		// Capture id so a stale response from a previous open can't clobber
		// the current state if the user opens lightbox A, closes, then opens
		// B before A's request resolves.
		const requested = id;
		fetch(`/api/media/${id}/conversations`)
			.then((r) => {
				if (!r.ok) throw new Error(`Server returned ${r.status}`);
				return r.json() as Promise<{ conversations: MediaConversationRef[] }>;
			})
			.then((body) => {
				if (lightbox?.id === requested) lightboxConversations = body.conversations;
			})
			.catch((e) => {
				if (lightbox?.id === requested) {
					conversationsError = e instanceof Error ? e.message : 'Failed to load conversations';
					lightboxConversations = [];
				}
			});
	});

	const kindFilter = $derived(data.kind);

	// Re-sync local state when SvelteKit re-runs `load` (e.g. filter switch via
	// query-string nav); the server gives us the new initial page. Bumping
	// loadGeneration supersedes any in-flight page fetch so its rows can't land
	// on the new filter; clearing loadingMore/loadError gives the fresh list a
	// clean slate (the in-flight fetch's finally won't touch them — it's gated
	// on still being the current generation).
	$effect(() => {
		items = [...data.initial.items];
		nextCursor = data.initial.nextCursor;
		loadGeneration += 1;
		loadingMore = false;
		loadError = null;
		error = null;
	});

	function setKind(k: 'image' | 'video' | null) {
		const url = new URL(page.url);
		if (k) url.searchParams.set('kind', k);
		else url.searchParams.delete('kind');
		goto(url, { keepFocus: true, noScroll: true, replaceState: false });
	}

	async function loadMore() {
		if (!nextCursor || loadingMore) return;
		loadingMore = true;
		loadError = null;
		const gen = loadGeneration;
		// Time the request out so a hung fetch can't strand loadingMore=true
		// forever (which would silently kill both the auto-load and the Retry
		// banner). An abort routes into the catch and surfaces Retry.
		const ctrl = new AbortController();
		const timer = setTimeout(() => ctrl.abort(), 15_000);
		try {
			const params = new URLSearchParams({ cursor: nextCursor });
			if (kindFilter) params.set('kind', kindFilter);
			const res = await fetch(`/api/media?${params.toString()}`, { signal: ctrl.signal });
			if (!res.ok) throw new Error(`Server returned ${res.status}`);
			const next = (await res.json()) as MediaListResult;
			// A filter switched while this was in flight — discard, or we'd mix
			// kinds into the new list and overwrite its cursor.
			if (gen !== loadGeneration) return;
			items = items.concat(next.items);
			nextCursor = next.nextCursor;
		} catch (e) {
			if (gen !== loadGeneration) return;
			loadError = ctrl.signal.aborted
				? 'Request timed out'
				: e instanceof Error
					? e.message
					: 'Failed to load more';
		} finally {
			clearTimeout(timer);
			// Only the current generation owns loadingMore; a filter switch
			// already reset it for the fresh list, so a stale fetch must not.
			if (gen === loadGeneration) loadingMore = false;
		}
	}

	// Watch the sentinel within the scroll container. The 400px bottom margin
	// pre-fetches the next page before the user actually hits the end, so the
	// grid grows ahead of the scroll rather than stalling at the bottom.
	// IntersectionObserver only fires on intersection *changes*, so the
	// auto-load below — not this callback — handles "still visible after a
	// load" by re-running until the sentinel scrolls out or pages run out.
	$effect(() =>
		observeSentinel(scrollContainer, sentinel, (v) => (sentinelVisible = v), {
			rootMargin: '0px 0px 400px 0px',
		}),
	);

	// Auto-paginate while the sentinel is in view. Depending on `loadingMore`
	// and `nextCursor` makes this re-run when a load settles: if the freshly
	// loaded page didn't push the sentinel out of the prefetch zone, it fires
	// again, chaining until the viewport is filled or `nextCursor` is null.
	// The `!loadError` guard stops a failed *page* request from retrying in a
	// tight loop — the banner's Retry button is the only way back in. A failed
	// delete sets `error`, not `loadError`, so it can't wedge scrolling.
	$effect(() => {
		if (sentinelVisible && nextCursor && !loadingMore && !loadError) {
			loadMore();
		}
	});

	async function deleteOne(id: string) {
		if (deletingId) return;
		const ok = await confirmDialog.ask({
			title: 'Delete this media?',
			message: 'This action cannot be undone.',
		});
		if (!ok) return;
		deletingId = id;
		error = null;
		try {
			const res = await fetch(`/api/media/${id}`, { method: 'DELETE' });
			if (!res.ok && res.status !== 404) throw new Error(`Server returned ${res.status}`);
			items = items.filter((m) => m.id !== id);
			if (lightbox?.id === id) lightbox = null;
		} catch (e) {
			error = e instanceof Error ? e.message : 'Failed to delete';
		} finally {
			deletingId = null;
		}
	}

	function enterSelectMode() {
		selectMode = true;
		selected = new Set();
		lightbox = null;
	}

	function exitSelectMode() {
		selectMode = false;
		selected = new Set();
	}

	function toggleSelected(id: string) {
		// Rebuild the Set so $state-tracked reactivity fires; in-place
		// add/delete on the same reference doesn't.
		const next = new Set(selected);
		if (next.has(id)) next.delete(id);
		else next.add(id);
		selected = next;
	}

	async function deleteSelected() {
		if (bulkDeleting || selected.size === 0) return;
		const count = selected.size;
		const ok = await confirmDialog.ask({
			title: count === 1 ? 'Delete 1 item?' : `Delete ${count} items?`,
			message: 'This action cannot be undone.',
		});
		if (!ok) return;
		bulkDeleting = true;
		error = null;
		try {
			const ids = Array.from(selected);
			const res = await fetch('/api/media/bulk-delete', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ ids }),
			});
			if (!res.ok) throw new Error(`Server returned ${res.status}`);
			// Optimistically drop every requested id regardless of how many
			// the server actually tombstoned — any in the request that
			// weren't tombstoned were already gone, so they shouldn't be in
			// the list anyway.
			const dropped = new Set(ids);
			items = items.filter((m) => !dropped.has(m.id));
			exitSelectMode();
		} catch (e) {
			error = e instanceof Error ? e.message : 'Failed to delete selected media';
		} finally {
			bulkDeleting = false;
		}
	}

	// Formatting helpers + Escape handling now live inside MediaLightbox —
	// see src/lib/components/MediaLightbox.svelte. The lightbox state is
	// still owned here so the conversations-fetch $effect above (and the
	// deleteOne handler that needs to close the lightbox on success) can
	// observe + mutate it directly.
</script>

<div class="flex h-full flex-col overflow-hidden">
	<header class="flex shrink-0 items-center justify-between gap-3 px-4 py-3">
		<h1 class="text-lg font-semibold tracking-tight">Gallery</h1>
		<div class="flex items-center gap-2 text-xs">
			{#if selectMode}
				<span class="text-fg-muted">
					{selectedCount === 0 ? 'Select items' : `${selectedCount} selected`}
				</span>
				<button
					type="button"
					onclick={deleteSelected}
					disabled={bulkDeleting || selectedCount === 0}
					class="rounded-md btn-danger px-3 py-1.5 transition disabled:opacity-40"
				>
					{bulkDeleting ? 'Deleting…' : 'Delete'}
				</button>
				<button
					type="button"
					onclick={exitSelectMode}
					disabled={bulkDeleting}
					class="rounded-md border border-border-strong bg-surface-panel px-3 py-1.5 transition hover:bg-surface-raised disabled:opacity-40"
				>
					Cancel
				</button>
			{:else}
				<div class="flex gap-1">
					{#each [{ k: null, label: 'All' }, { k: 'image', label: 'Images' }, { k: 'video', label: 'Videos' }] as { k, label } (label)}
						{@const active = kindFilter === k}
						<button
							type="button"
							onclick={() => setKind(k as 'image' | 'video' | null)}
							class="rounded-md border px-3 py-1.5 transition {active
								? 'border-surface-inverse bg-surface-inverse text-fg-inverse'
								: 'border-border-strong bg-surface-panel hover:bg-surface-raised'}"
						>
							{label}
						</button>
					{/each}
				</div>
				{#if items.length > 0}
					<button
						type="button"
						onclick={enterSelectMode}
						class="rounded-md border border-border-strong bg-surface-panel px-3 py-1.5 transition hover:bg-surface-raised"
					>
						Select
					</button>
				{/if}
			{/if}
		</div>
	</header>

	<div bind:this={scrollContainer} class="flex-1 overflow-y-auto px-4 py-4">
		{#if items.length === 0}
			<div class="flex h-full flex-col items-center justify-center text-center">
				<p class="text-sm text-fg-muted">No media yet.</p>
				<p class="mt-1 text-xs text-fg-subtle">
					Generated images and videos from your chats appear here.
				</p>
			</div>
		{:else}
			<!--
				CSS grid masonry with a fixed thumbnail row height. Simpler than a
				JS masonry library and good enough for v1: thumbnails are uniform
				cells; clicking opens the full asset in the lightbox at native
				aspect ratio.
			-->
			<ul
				class="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6"
			>
				{#each items as m (m.id)}
					{@const isSelected = selectMode && selected.has(m.id)}
					<li
						class="group relative overflow-hidden rounded-lg border bg-surface-raised transition {isSelected
							? 'border-surface-inverse ring-2 ring-surface-inverse'
							: 'border-border hover:border-border-focus'}"
					>
						<button
							type="button"
							onclick={() => (selectMode ? toggleSelected(m.id) : (lightbox = m))}
							class="block w-full"
							aria-label={selectMode
								? isSelected
									? `Deselect ${m.kind}`
									: `Select ${m.kind}`
								: `Open ${m.kind} ${m.promptExcerpt ?? ''}`}
							aria-pressed={selectMode ? isSelected : undefined}
						>
							<div class="relative aspect-square w-full overflow-hidden">
								{#if m.kind === 'image'}
									<!--
										Grid tiles use the /thumbnail variant, not /content.
										See src/lib/server/media/thumbnail.ts — server-side
										sharp resize to 512px JPEG q=75, lazy-generated and
										disk-cached on first request. Roughly 20x bandwidth
										reduction per tile vs. full-resolution originals.
										Lightbox + chat-side rendering still pull /content
										for full quality.
									-->
									<img
										src="/api/media/{m.id}/thumbnail"
										alt={m.promptExcerpt ?? 'Generated image'}
										loading="lazy"
										class="h-full w-full object-cover"
									/>
								{:else}
									<!--
										#t=0.1 is a Media Fragment URI: tells the browser to seek
										to 0.1s on load so it renders that frame as an inline poster.
										Avoids needing a server-side ffmpeg poster pipeline. The 0.1
										(vs 0) sidesteps encoders that begin with a black/blue frame.
									-->
									<!-- svelte-ignore a11y_media_has_caption -->
									<video
										src="/api/media/{m.id}/content#t=0.1"
										preload="metadata"
										muted
										playsinline
										class="h-full w-full object-cover"
									></video>
									<div
										class="absolute right-1.5 top-1.5 rounded bg-black/60 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-white"
									>
										video
									</div>
								{/if}
							</div>
							{#if m.promptExcerpt}
								<div class="px-2 py-1.5 text-left text-xs text-fg-secondary line-clamp-2">
									{m.promptExcerpt}
								</div>
							{/if}
						</button>
						{#if selectMode}
							<!--
								Checkbox badge for selection mode. Purely visual — the
								whole tile is the toggle (the wrapping button handles
								the click), so the badge is aria-hidden and not its
								own focus target.
							-->
							<span
								aria-hidden="true"
								class="pointer-events-none absolute left-1.5 top-1.5 flex h-5 w-5 items-center justify-center rounded-full border-2 text-[12px] font-bold transition {isSelected
									? 'border-surface-inverse bg-surface-inverse text-fg-inverse'
									: 'border-white/80 bg-black/40 text-transparent'}"
							>
								✓
							</span>
						{:else}
							<button
								type="button"
								onclick={() => deleteOne(m.id)}
								disabled={deletingId === m.id}
								class="absolute left-1.5 top-1.5 rounded bg-danger-emphasis/90 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-danger-fg opacity-0 transition group-hover:opacity-100 hover:bg-danger-emphasis disabled:opacity-50"
								aria-label="Delete this media"
								title="Delete"
							>
								{deletingId === m.id ? '…' : '×'}
							</button>
						{/if}
					</li>
				{/each}
			</ul>

			{#if nextCursor}
				<!--
					Infinite-scroll sentinel. The IntersectionObserver effect above
					watches this marker and auto-loads the next page as it nears the
					viewport — replacing the old manual "Load more" button. It only
					exists while there's a next page, so the observer detaches on the
					last page. While a fetch is in flight we show a quiet status line.
				-->
				<div bind:this={sentinel} class="mt-6 flex h-8 justify-center" aria-hidden="true">
					{#if loadingMore}
						<span class="text-sm text-fg-muted">Loading…</span>
					{/if}
				</div>
			{/if}
		{/if}

		{#if loadError}
			<!--
				Pagination failure. Retry re-runs loadMore (not whatever else may
				have failed) and is always available here: loadError is only set
				while a next page exists, so there's no last-page dead end.
			-->
			<div
				class="mt-4 flex items-center justify-between gap-3 rounded-md border px-3 py-2 text-sm alert-danger"
			>
				<span>{loadError}</span>
				<button
					type="button"
					onclick={() => {
						loadError = null;
						loadMore();
					}}
					class="shrink-0 rounded-md border border-border-strong bg-surface-panel px-3 py-1 text-xs transition hover:bg-surface-raised"
				>
					Retry
				</button>
			</div>
		{/if}

		{#if error}
			<!-- Delete failure (single or bulk). Distinct from loadError so it
				 never gates scrolling; re-attempting the delete clears it. -->
			<div class="mt-4 rounded-md border px-3 py-2 text-sm alert-danger">
				{error}
			</div>
		{/if}
	</div>
</div>

<MediaLightbox
	media={lightbox}
	onClose={() => (lightbox = null)}
	onDelete={deleteOne}
	{deletingId}
	conversationsUsingThis={lightboxConversations}
	{conversationsError}
	siblings={items.map((m) => ({ id: m.id, kind: m.kind }))}
	onNavigate={(id) => {
		// All gallery items are already in memory, so navigation is an
		// instant in-array swap — no fetch. The conversations effect
		// (keyed on lightbox.id) refetches the new item's refs.
		const found = items.find((m) => m.id === id);
		if (found) lightbox = found;
	}}
/>
