<script lang="ts">
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import type { MediaListItem, MediaListResult } from '$lib/server/db/queries/media';

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
		if (!confirm('Delete this media? This cannot be undone.')) return;
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

	function fmtBytes(n: number): string {
		if (n < 1024) return `${n} B`;
		if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
		return `${(n / (1024 * 1024)).toFixed(1)} MB`;
	}

	function fmtDate(ms: number): string {
		return new Date(ms).toLocaleString();
	}

	function onLightboxKey(e: KeyboardEvent) {
		if (e.key === 'Escape') lightbox = null;
	}
</script>

<svelte:window onkeydown={onLightboxKey} />

<div class="flex h-full flex-col overflow-hidden">
	<header class="flex shrink-0 items-center justify-between gap-3 border-b border-neutral-200 px-4 py-3 dark:border-neutral-800">
		<h1 class="text-lg font-semibold tracking-tight">Gallery</h1>
		<div class="flex gap-1 text-xs">
			{#each [{ k: null, label: 'All' }, { k: 'image', label: 'Images' }, { k: 'video', label: 'Videos' }] as { k, label } (label)}
				{@const active = kindFilter === k}
				<button
					type="button"
					onclick={() => setKind(k as 'image' | 'video' | null)}
					class="rounded-md border px-3 py-1.5 transition {active
						? 'border-neutral-900 bg-neutral-900 text-white dark:border-neutral-100 dark:bg-neutral-100 dark:text-neutral-900'
						: 'border-neutral-300 bg-white hover:bg-neutral-100 dark:border-neutral-700 dark:bg-neutral-900 dark:hover:bg-neutral-800'}"
				>
					{label}
				</button>
			{/each}
		</div>
	</header>

	<div class="flex-1 overflow-y-auto px-4 py-4">
		{#if items.length === 0}
			<div class="flex h-full flex-col items-center justify-center text-center">
				<p class="text-sm text-neutral-500">No media yet.</p>
				<p class="mt-1 text-xs text-neutral-400">
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
					<li class="group relative overflow-hidden rounded-lg border border-neutral-200 bg-neutral-100 transition hover:border-neutral-400 dark:border-neutral-800 dark:bg-neutral-900 dark:hover:border-neutral-600">
						<button
							type="button"
							onclick={() => (lightbox = m)}
							class="block w-full"
							aria-label="Open {m.kind} {m.promptExcerpt ?? ''}"
						>
							<div class="relative aspect-square w-full overflow-hidden">
								{#if m.kind === 'image'}
									<img
										src="/api/media/{m.id}/content"
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
								<div class="px-2 py-1.5 text-left text-xs text-neutral-700 line-clamp-2 dark:text-neutral-300">
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
						class="rounded-md border border-neutral-300 bg-white px-4 py-2 text-sm transition hover:bg-neutral-100 disabled:opacity-50 dark:border-neutral-700 dark:bg-neutral-900 dark:hover:bg-neutral-800"
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

{#if lightbox}
	{@const m = lightbox}
	<!-- svelte-ignore a11y_click_events_have_key_events a11y_interactive_supports_focus -->
	<div
		role="dialog"
		aria-modal="true"
		aria-label="Media preview"
		tabindex="-1"
		class="fixed inset-0 z-50 flex flex-col bg-black/90 p-4 backdrop-blur"
		onclick={(e) => {
			if (e.target === e.currentTarget) lightbox = null;
		}}
	>
		<div class="flex shrink-0 items-center justify-between gap-3 pb-3 text-sm text-neutral-200">
			<div class="flex flex-col text-xs">
				<span class="font-medium">{m.sourceModel ?? 'Unknown model'}</span>
				<span class="opacity-70">{fmtDate(m.createdAt)} · {fmtBytes(m.byteSize)} · {m.contentType}</span>
			</div>
			<div class="flex gap-2">
				<a
					href="/api/media/{m.id}/content"
					download
					class="rounded-md border border-neutral-600 bg-neutral-800 px-3 py-1.5 text-xs transition hover:bg-neutral-700"
				>
					Download
				</a>
				<button
					type="button"
					onclick={() => deleteOne(m.id)}
					disabled={deletingId === m.id}
					class="rounded-md border border-red-700 bg-red-700 px-3 py-1.5 text-xs text-white transition hover:bg-red-800 disabled:opacity-50"
				>
					{deletingId === m.id ? 'Deleting…' : 'Delete'}
				</button>
				<button
					type="button"
					onclick={() => (lightbox = null)}
					aria-label="Close"
					class="rounded-md border border-neutral-600 bg-neutral-800 px-3 py-1.5 text-xs transition hover:bg-neutral-700"
				>
					Close
				</button>
			</div>
		</div>
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
					class="max-h-full max-w-full rounded-lg"
				></video>
			{/if}
		</div>
		{#if m.promptExcerpt}
			<p class="mx-auto mt-3 max-w-3xl shrink-0 text-center text-xs text-neutral-300 line-clamp-3">
				{m.promptExcerpt}
			</p>
		{/if}
	</div>
{/if}
