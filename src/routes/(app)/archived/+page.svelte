<script lang="ts">
	import { goto, invalidateAll } from '$app/navigation';
	import { DropdownMenu } from 'bits-ui';
	import { ArchiveRestore, MoreVertical, Trash2 } from 'lucide-svelte';
	import type { ConversationSummary } from '$lib/types/api';

	let { data } = $props<{ data: { archivedConversations: ConversationSummary[] } }>();

	let busyId = $state<string | null>(null);

	function formatDate(ms: number): string {
		const d = new Date(ms);
		const now = new Date();
		const sameYear = d.getFullYear() === now.getFullYear();
		return d.toLocaleDateString(undefined, {
			month: 'short',
			day: 'numeric',
			year: sameYear ? undefined : 'numeric'
		});
	}

	async function unarchive(id: string) {
		if (busyId) return;
		busyId = id;
		try {
			const res = await fetch(`/api/conversations/${id}`, {
				method: 'PATCH',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ archived: false })
			});
			if (!res.ok && res.status !== 404) {
				throw new Error(`Server returned ${res.status}`);
			}
			await invalidateAll();
		} catch (e) {
			alert(`Couldn't unarchive: ${e instanceof Error ? e.message : String(e)}`);
		} finally {
			busyId = null;
		}
	}

	async function deleteConversation(id: string) {
		if (busyId) return;
		if (!confirm('Delete this conversation? This cannot be undone.')) return;
		busyId = id;
		try {
			const res = await fetch(`/api/conversations/${id}`, { method: 'DELETE' });
			if (!res.ok && res.status !== 404) {
				throw new Error(`Server returned ${res.status}`);
			}
			await invalidateAll();
		} catch (e) {
			alert(`Couldn't delete: ${e instanceof Error ? e.message : String(e)}`);
		} finally {
			busyId = null;
		}
	}

	function openConversation(id: string) {
		goto(`/chat/${id}`);
	}
</script>

<div class="flex h-full flex-col overflow-hidden">
	<header class="shrink-0 px-4 py-3">
		<h1 class="text-lg font-semibold tracking-tight">Archived conversations</h1>
		<p class="text-xs text-neutral-500">
			Click to reopen, or use the menu to unarchive or delete.
		</p>
	</header>

	<div class="flex-1 overflow-y-auto px-4 py-2">
		{#if data.archivedConversations.length === 0}
			<p class="px-2 py-12 text-center text-sm text-neutral-500">
				No archived conversations.
			</p>
		{:else}
			<ul class="mx-auto max-w-3xl space-y-0.5">
				{#each data.archivedConversations as c (c.id)}
					<li class="group relative">
						<button
							type="button"
							onclick={() => openConversation(c.id)}
							class="flex w-full items-center justify-between gap-3 rounded-md py-2.5 pl-3 pr-10 text-left text-sm transition hover:bg-neutral-200/70 dark:hover:bg-neutral-800"
						>
							<span class="min-w-0 flex-1 truncate">{c.title ?? 'Untitled'}</span>
							<span class="shrink-0 text-xs text-neutral-500">{formatDate(c.updatedAt)}</span>
						</button>
						<DropdownMenu.Root>
							<DropdownMenu.Trigger
								disabled={busyId === c.id}
								title="Conversation options"
								aria-label="Options for conversation {c.title ?? 'Untitled'}"
								class="absolute right-1 top-1/2 flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded border-0 bg-transparent text-neutral-500 opacity-0 transition hover:bg-neutral-300 hover:text-neutral-700 focus-visible:opacity-100 disabled:opacity-50 group-hover:opacity-100 data-[state=open]:opacity-100 dark:hover:bg-neutral-700 dark:hover:text-neutral-200"
							>
								<MoreVertical size={14} strokeWidth={2.25} />
							</DropdownMenu.Trigger>
							<DropdownMenu.Portal>
								<DropdownMenu.Content
									sideOffset={4}
									align="end"
									class="z-50 min-w-[160px] overflow-hidden rounded-md border border-neutral-200 bg-white py-1 shadow-lg dark:border-neutral-700 dark:bg-neutral-900"
								>
									<DropdownMenu.Item
										onSelect={() => unarchive(c.id)}
										class="flex cursor-pointer items-center gap-2 px-3 py-1.5 text-sm transition data-[highlighted]:bg-neutral-100 dark:data-[highlighted]:bg-neutral-800"
									>
										<ArchiveRestore size={14} strokeWidth={2.25} />
										<span>Unarchive</span>
									</DropdownMenu.Item>
									<DropdownMenu.Item
										onSelect={() => deleteConversation(c.id)}
										class="flex cursor-pointer items-center gap-2 px-3 py-1.5 text-sm text-red-600 transition data-[highlighted]:bg-red-50 dark:text-red-400 dark:data-[highlighted]:bg-red-950/40"
									>
										<Trash2 size={14} strokeWidth={2.25} />
										<span>Delete</span>
									</DropdownMenu.Item>
								</DropdownMenu.Content>
							</DropdownMenu.Portal>
						</DropdownMenu.Root>
					</li>
				{/each}
			</ul>
		{/if}
	</div>
</div>
