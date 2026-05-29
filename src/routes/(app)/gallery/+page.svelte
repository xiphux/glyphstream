<script lang="ts">
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import MediaLightbox from '$lib/components/MediaLightbox.svelte';
	import { confirmDialog } from '$lib/confirm.svelte';
	import type {
		MediaConversationRef,
		MediaListItem,
		MediaListResult
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
	let error = $state<string | null>(null);
	let lightbox = $state<MediaListItem | null>(null);
	let deletingId = $state<string | null>(null);

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
		lightboxConversations = null;
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
	// query-string nav); the server gives us the new initial page.
	$effect(() => {
		items = [...data.initial.items];
		nextCursor = data.initial.nextCursor;
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
		error = null;
		try {
			const params = new URLSearchParams({ cursor: nextCursor });
			if (kindFilter) params.set('kind', kindFilter);
			const res = await fetch(`/api/media?${params.toString()}`);
			if (!res.ok) throw new Error(`Server returned ${res.status}`);
			const next = (await res.json()) as MediaListResult;
			items = items.concat(next.items);
			nextCursor = next.nextCursor;
		} catch (e) {
			error = e instanceof Error ? e.message : 'Failed to load more';
		} finally {
			loadingMore = false;
		}
	}

	async function deleteOne(id: string) {
		if (deletingId) return;
		const ok = await confirmDialog.ask({
			title: 'Delete this media?',
			message: 'This action cannot be undone.'
		});
		if (!ok) return;
		deletingId = id;
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

	// Formatting helpers + Escape handling now live inside MediaLightbox —
	// see src/lib/components/MediaLightbox.svelte. The lightbox state is
	// still owned here so the conversations-fetch $effect above (and the
	// deleteOne handler that needs to close the lightbox on success) can
	// observe + mutate it directly.
</script>

<div class="flex h-full flex-col overflow-hidden">
	<header class="flex shrink-0 items-center justify-between gap-3 px-4 py-3">
		<h1 class="text-lg font-semibold tracking-tight">Gallery</h1>
		<div class="flex gap-1 text-xs">
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
	</header>

	<div class="flex-1 overflow-y-auto px-4 py-4">
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
			<ul class="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6">
				{#each items as m (m.id)}
					<li class="group relative overflow-hidden rounded-lg border border-border bg-surface-raised transition hover:border-border-focus">
						<button
							type="button"
							onclick={() => (lightbox = m)}
							class="block w-full"
							aria-label="Open {m.kind} {m.promptExcerpt ?? ''}"
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
									<div class="absolute right-1.5 top-1.5 rounded bg-black/60 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-white">
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
						<button
							type="button"
							onclick={() => deleteOne(m.id)}
							disabled={deletingId === m.id}
							class="absolute left-1.5 top-1.5 rounded bg-red-600/85 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-white opacity-0 transition group-hover:opacity-100 hover:bg-red-700 disabled:opacity-50"
							aria-label="Delete this media"
							title="Delete"
						>
							{deletingId === m.id ? '…' : '×'}
						</button>
					</li>
				{/each}
			</ul>

			{#if nextCursor}
				<div class="mt-6 flex justify-center">
					<button
						type="button"
						onclick={loadMore}
						disabled={loadingMore}
						class="rounded-md border border-border-strong bg-surface-panel px-4 py-2 text-sm transition hover:bg-surface-raised disabled:opacity-50"
					>
						{loadingMore ? 'Loading…' : 'Load more'}
					</button>
				</div>
			{/if}
		{/if}

		{#if error}
			<div class="mt-4 rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800 dark:border-red-700 dark:bg-red-950 dark:text-red-200">
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
/>
