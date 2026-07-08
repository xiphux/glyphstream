<script lang="ts">
	import { invalidate } from '$app/navigation';
	import { RotateCcw, Trash2 } from '@lucide/svelte';
	import type { Memory, DeletedMemory } from '$lib/types/api';
	import { confirmDialog } from '$lib/confirm.svelte';
	import { toast } from '$lib/toast.svelte';

	let { data } = $props<{
		data: {
			memories: Memory[];
			deletedMemories?: DeletedMemory[];
			conversationOverview?: { overview: string | null; updatedAt: number | null };
		};
	}>();

	let busyId = $state<string | null>(null);

	// Empty on installs without a [memory_model] — only the dreaming pass
	// soft-deletes, so there's nothing to recover there.
	let deletedMemories = $derived(data.deletedMemories ?? []);

	// The conversation-topics map injected into the persona prompt (view-only —
	// it's regenerated from conversations, so hand-edits wouldn't stick). Null
	// until the background pass has built one.
	let overview = $derived(data.conversationOverview?.overview ?? null);
	let overviewUpdatedAt = $derived(data.conversationOverview?.updatedAt ?? null);

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

	async function restore(m: DeletedMemory) {
		if (busyId) return;
		// No confirm — restore is non-destructive (it just moves the row back to
		// the live list), unlike the permanent forget.
		busyId = m.id;
		try {
			const res = await fetch(`/api/user/memories/${encodeURIComponent(m.id)}/restore`, {
				method: 'POST',
			});
			if (!res.ok && res.status !== 404) {
				throw new Error(`HTTP ${res.status}`);
			}
			await invalidate('settings:memories');
		} catch (e) {
			toast.error(`Couldn't restore: ${e instanceof Error ? e.message : String(e)}`);
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
								class="absolute right-1 top-1.5 flex h-7 w-7 items-center justify-center rounded border-0 bg-transparent text-fg-muted opacity-0 transition hover:bg-surface-sunken hover:text-danger focus-visible:opacity-100 disabled:opacity-50 group-hover:opacity-100"
							>
								<Trash2 size={14} strokeWidth={2.25} />
							</button>
						</li>
					{/each}
				</ul>
			{/if}
		</div>

		{#if deletedMemories.length > 0}
			<details class="mx-auto mt-4 max-w-2xl rounded-lg border border-border bg-surface-panel p-4">
				<summary class="cursor-pointer text-sm font-medium text-fg-muted select-none">
					Recently tidied ({deletedMemories.length})
				</summary>
				<p class="mt-1 text-xs text-fg-muted">
					Memories the background tidy pass merged or removed. Restore any it shouldn't have touched
					— otherwise they're permanently deleted about 30 days after tidying.
				</p>
				<ul class="mt-3 flex flex-col gap-0.5">
					{#each deletedMemories as m (m.id)}
						<li class="group relative">
							<div
								class="flex items-start gap-3 rounded-md py-2.5 pl-3 pr-10 text-sm transition hover:bg-surface-sunken/70"
							>
								<span class="min-w-0 flex-1">
									<span
										class="whitespace-pre-wrap break-words text-fg-muted line-through decoration-fg-muted/40"
										>{m.content}</span
									>
									<span class="mt-0.5 block text-xs text-fg-muted/80">
										{#if m.supersededByContent}
											Merged into: {truncate(m.supersededByContent, 80)}
										{:else}
											Removed
										{/if}
									</span>
								</span>
								<span class="shrink-0 pt-0.5 text-xs text-fg-muted">{formatDate(m.deletedAt)}</span>
							</div>
							<button
								type="button"
								disabled={busyId === m.id}
								onclick={() => restore(m)}
								title="Restore this memory"
								aria-label="Restore memory"
								class="absolute right-1 top-1.5 flex h-7 w-7 items-center justify-center rounded border-0 bg-transparent text-fg-muted opacity-0 transition hover:bg-surface-sunken hover:text-fg focus-visible:opacity-100 disabled:opacity-50 group-hover:opacity-100"
							>
								<RotateCcw size={14} strokeWidth={2.25} />
							</button>
						</li>
					{/each}
				</ul>
			</details>
		{/if}

		{#if overview}
			<section class="mx-auto mt-4 max-w-2xl rounded-lg border border-border bg-surface-panel p-4">
				<h2 class="text-sm font-semibold tracking-tight">Conversation topics</h2>
				<p class="mt-1 text-xs text-fg-muted">
					An automatically generated map of what you've discussed across conversations, injected so
					the assistant knows what past chats it can search. It's rebuilt from your conversations
					periodically, so it isn't edited here — to change it, manage the underlying conversations.
					{#if overviewUpdatedAt}
						<span class="whitespace-nowrap">Updated {formatDate(overviewUpdatedAt)}.</span>
					{/if}
				</p>
				<div
					class="mt-3 whitespace-pre-wrap break-words rounded-md bg-surface-sunken/50 p-3 text-sm text-fg"
				>
					{overview}
				</div>
			</section>
		{/if}
	</div>
</div>
