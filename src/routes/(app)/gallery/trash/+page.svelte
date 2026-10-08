<script lang="ts">
	import { invalidateAll } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { ChevronLeft, ZoomIn } from '@lucide/svelte';
	import MediaLightbox from '$lib/components/MediaLightbox.svelte';
	import { confirmDialog } from '$lib/confirm.svelte';
	import { toast } from '$lib/toast.svelte';
	import { friendlyModelName } from '$lib/model-ids';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	let selected = $state<Set<string>>(new Set());
	let busy = $state(false);
	// A selection can outlive its items (another tab purged them, or the sweep
	// expired one while the page sat open), so every count and request reads the
	// selection through the current list rather than trusting the raw set.
	const liveIds = $derived(new Set(data.items.map((i) => i.id)));
	const selectedIds = $derived([...selected].filter((id) => liveIds.has(id)));
	const selectedCount = $derived(selectedIds.length);

	// The full-size view. Held as an id and resolved against the current list, so
	// a reload that drops the item (purged from another tab, expired) closes it
	// rather than leaving it showing something that's gone.
	let viewingId = $state<string | null>(null);
	const viewing = $derived(data.items.find((i) => i.id === viewingId) ?? null);
	const siblings = $derived(data.items.map(({ id, kind }) => ({ id, kind })));

	function toggle(id: string) {
		const next = new Set(selected);
		if (next.has(id)) next.delete(id);
		else next.add(id);
		selected = next;
	}

	const DAY_MS = 24 * 60 * 60 * 1000;
	function timeLeft(expiresAt: number): string {
		const days = Math.ceil((expiresAt - Date.now()) / DAY_MS);
		if (days <= 1) return 'Less than a day';
		return `${days} days`;
	}

	function plural(n: number): string {
		return n === 1 ? '1 item' : `${n} items`;
	}

	async function post(path: string, body: object): Promise<Record<string, number>> {
		const res = await fetch(path, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(body),
		});
		if (!res.ok) throw new Error(`Server returned ${res.status}`);
		return (await res.json()) as Record<string, number>;
	}

	/** Restore `ids`; `after` runs once the server has them back, before the
	 *  list reloads. Shared by the toolbar (the selection) and the viewer (the
	 *  one item on screen). */
	async function restore(ids: string[], after: () => void) {
		if (busy || ids.length === 0) return;
		busy = true;
		try {
			const { restored } = await post('/api/media/trash/restore', { ids });
			after();
			toast.success(`Restored ${plural(restored)} to the gallery`);
			await invalidateAll();
		} catch (e) {
			toast.error(`Couldn't restore: ${e instanceof Error ? e.message : String(e)}`);
		} finally {
			busy = false;
		}
	}

	function restoreSelected() {
		return restore(selectedIds, () => (selected = new Set()));
	}

	/** From the viewer: step to a neighbour (next, else previous) so a review
	 *  pass can carry on; the restored item drops out of the list on reload,
	 *  and with nothing left the viewer closes itself (`viewing` goes null). */
	function restoreViewing(id: string) {
		const i = data.items.findIndex((m) => m.id === id);
		const neighbour = data.items[i + 1] ?? data.items[i - 1] ?? null;
		return restore([id], () => (viewingId = neighbour?.id ?? null));
	}

	async function purge(all: boolean) {
		if (busy) return;
		const count = all ? data.items.length : selectedCount;
		if (count === 0) return;
		const ok = await confirmDialog.ask({
			title: all ? 'Empty Recently deleted?' : `Delete ${plural(count)} forever?`,
			message: 'This action cannot be undone.',
			confirmLabel: all ? 'Empty' : 'Delete forever',
		});
		if (!ok) return;
		busy = true;
		try {
			// Empty sends the newest deletion on screen (the list is newest-first)
			// rather than "everything", so nothing deleted since the page loaded
			// goes with it unseen.
			await post(
				'/api/media/trash/purge',
				all ? { deletedUpTo: data.items[0].deletedAt } : { ids: selectedIds },
			);
			selected = new Set();
			await invalidateAll();
		} catch (e) {
			toast.error(`Couldn't delete: ${e instanceof Error ? e.message : String(e)}`);
		} finally {
			busy = false;
		}
	}
</script>

<div class="flex h-full flex-col overflow-hidden">
	<header class="flex shrink-0 flex-wrap items-center justify-between gap-3 px-4 py-3">
		<div class="flex min-w-0 items-center gap-2">
			<a
				href={resolve('/gallery')}
				class="-ml-1 flex shrink-0 items-center gap-1 rounded-md px-2 py-1.5 text-sm transition hover:bg-surface-raised"
				aria-label="Back to gallery"
			>
				<ChevronLeft size={18} />
				Gallery
			</a>
			<h1 class="truncate text-lg font-semibold tracking-tight">Recently deleted</h1>
		</div>
		<div class="flex flex-wrap items-center gap-2 text-xs">
			{#if selectedCount > 0}
				<span class="text-fg-muted">{selectedCount} selected</span>
				<button
					type="button"
					onclick={restoreSelected}
					disabled={busy}
					class="inline-flex h-8 items-center rounded-md bg-surface-inverse px-3 text-fg-inverse transition disabled:opacity-40"
				>
					Restore
				</button>
				<button
					type="button"
					onclick={() => purge(false)}
					disabled={busy}
					class="inline-flex h-8 items-center rounded-md btn-danger px-3 transition disabled:opacity-40"
				>
					Delete forever
				</button>
				<button
					type="button"
					onclick={() => (selected = new Set())}
					disabled={busy}
					class="inline-flex h-8 items-center rounded-md border border-border-strong bg-surface-panel px-3 transition hover:bg-surface-raised disabled:opacity-40"
				>
					Cancel
				</button>
			{:else if data.items.length > 0}
				<button
					type="button"
					onclick={() => purge(true)}
					disabled={busy}
					class="inline-flex h-8 items-center rounded-md border border-border-strong bg-surface-panel px-3 text-danger transition hover:bg-surface-raised disabled:opacity-40"
				>
					Empty
				</button>
			{/if}
		</div>
	</header>

	<div class="flex-1 overflow-y-auto px-4 pb-4">
		<p class="pb-3 text-xs text-fg-muted">
			Deleted images and videos stay here for 30 days, then are removed for good. Restored items
			return to the gallery, but not to the conversation they came from.
		</p>
		{#if data.items.length === 0}
			<p class="px-2 py-12 text-center text-sm text-fg-muted">Nothing here.</p>
		{:else}
			<ul
				class="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6"
			>
				{#each data.items as m (m.id)}
					{@const isSelected = selected.has(m.id)}
					<li
						class="relative overflow-hidden rounded-lg border bg-surface-raised transition {isSelected
							? 'border-surface-inverse ring-2 ring-surface-inverse'
							: 'border-border hover:border-border-focus'}"
					>
						<button
							type="button"
							onclick={() => toggle(m.id)}
							aria-pressed={isSelected}
							aria-label="{isSelected ? 'Deselect' : 'Select'} {m.kind} {m.promptExcerpt ?? ''}"
							title={[m.promptExcerpt, m.sourceModel && friendlyModelName(m.sourceModel)]
								.filter(Boolean)
								.join(' — ')}
							class="block w-full"
						>
							<div class="relative aspect-square w-full overflow-hidden">
								<!-- The thumbnail endpoint serves a video's poster frame, so one
								     <img> covers both kinds; a trash tile never plays. -->
								<img
									src="/api/media/{m.id}/thumbnail?trash=1"
									alt={m.promptExcerpt ?? `Deleted ${m.kind}`}
									loading="lazy"
									class="h-full w-full object-cover {isSelected ? '' : 'opacity-80'}"
								/>
								<span
									aria-hidden="true"
									class="pointer-events-none absolute left-1.5 top-1.5 flex h-5 w-5 items-center justify-center rounded-full border-2 text-[12px] font-bold transition {isSelected
										? 'border-surface-inverse bg-surface-inverse text-fg-inverse'
										: 'border-white/80 bg-black/40 text-transparent'}"
								>
									✓
								</span>
								{#if m.kind === 'video'}
									<span
										aria-hidden="true"
										class="pointer-events-none absolute top-1.5 right-1.5 rounded bg-black/60 px-1.5 py-0.5 text-[10px] font-medium text-white uppercase"
									>
										Video
									</span>
								{/if}
								<div
									class="pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/90 via-black/60 to-transparent pt-8 pr-11 pb-1.5 pl-2 text-left text-xs text-white"
								>
									{timeLeft(m.expiresAt)} left
								</div>
							</div>
						</button>
						<!-- A tap on the tile selects (this page's whole job is choosing what to
						     restore), so the full-size view gets its own corner target, the
						     way Google Photos does it in select mode. A sibling of the tile
						     button, not a child: buttons don't nest. -->
						<button
							type="button"
							onclick={() => (viewingId = m.id)}
							aria-label="View {m.kind} full size"
							title="View full size"
							class="absolute right-1 bottom-1 flex h-8 w-8 items-center justify-center rounded-full bg-black/50 text-white transition hover:bg-black/70"
						>
							<ZoomIn size={16} />
						</button>
					</li>
				{/each}
			</ul>
		{/if}
	</div>
</div>

<MediaLightbox
	media={viewing}
	onClose={() => (viewingId = null)}
	{siblings}
	onNavigate={(id: string) => (viewingId = id)}
	onRestore={restoreViewing}
	restoringId={busy ? viewingId : null}
	trashed
/>
