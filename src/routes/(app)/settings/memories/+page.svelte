<script lang="ts">
	import { invalidate } from '$app/navigation';
	import { Trash2 } from '@lucide/svelte';
	import type { Memory } from '$lib/types/api';
	import { confirmDialog } from '$lib/confirm.svelte';
	import { toast } from '$lib/toast.svelte';

	let { data } = $props<{ data: { memories: Memory[] } }>();

	let busyId = $state<string | null>(null);

	function formatDate(ms: number): string {
		const d = new Date(ms);
		const now = new Date();
		const sameYear = d.getFullYear() === now.getFullYear();
		return d.toLocaleDateString(undefined, {
			month: 'short',
			day: 'numeric',
			year: sameYear ? undefined : 'numeric',
		});
	}

	function truncate(text: string, max: number): string {
		if (text.length <= max) return text;
		return text.slice(0, max - 1).trimEnd() + '…';
	}

	async function requestForget(m: Memory) {
		if (busyId) return;
		const ok = await confirmDialog.ask({
			title: 'Forget this memory?',
			message: truncate(m.content, 140),
			confirmLabel: 'Forget',
		});
		if (!ok) return;

		busyId = m.id;
		try {
			const res = await fetch(`/api/user/memories/${encodeURIComponent(m.id)}`, {
				method: 'DELETE',
			});
			if (!res.ok && res.status !== 404) {
				throw new Error(`HTTP ${res.status}`);
			}
			await invalidate('settings:memories');
		} catch (e) {
			toast.error(`Couldn't forget: ${e instanceof Error ? e.message : String(e)}`);
		} finally {
			busyId = null;
		}
	}
</script>

<div class="flex h-full flex-col overflow-hidden">
	<header class="shrink-0 px-4 py-3">
		<h1 class="text-lg font-semibold tracking-tight">Memories</h1>
		<p class="text-xs text-fg-muted">
			Standing facts the assistant has saved about you. These ride along in every new conversation
			when Personalization is on. Delete any that no longer apply.
		</p>
	</header>

	<div class="flex-1 overflow-y-auto px-4 py-4">
		<div class="mx-auto max-w-2xl rounded-lg border border-border bg-surface-panel p-4">
			{#if data.memories.length === 0}
				<p class="py-8 text-center text-sm text-fg-muted">
					No memories saved yet. The assistant will save things here as they come up.
				</p>
			{:else}
				<ul class="flex flex-col gap-0.5">
					{#each data.memories as m (m.id)}
						<li class="group relative">
							<div
								class="flex items-start gap-3 rounded-md py-2.5 pl-3 pr-10 text-sm transition hover:bg-surface-sunken/70"
							>
								<span class="min-w-0 flex-1 whitespace-pre-wrap break-words">{m.content}</span>
								<span class="shrink-0 pt-0.5 text-xs text-fg-muted">{formatDate(m.createdAt)}</span>
							</div>
							<button
								type="button"
								disabled={busyId === m.id}
								onclick={() => requestForget(m)}
								title="Forget this memory"
								aria-label="Forget memory"
								class="absolute right-1 top-1.5 flex h-7 w-7 items-center justify-center rounded border-0 bg-transparent text-fg-muted opacity-0 transition hover:bg-surface-sunken hover:text-red-600 focus-visible:opacity-100 disabled:opacity-50 group-hover:opacity-100 dark:hover:text-red-400"
							>
								<Trash2 size={14} strokeWidth={2.25} />
							</button>
						</li>
					{/each}
				</ul>
			{/if}
		</div>
	</div>
</div>
