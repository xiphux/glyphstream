<script lang="ts">
	import { goto, invalidateAll } from '$app/navigation';
	import { DropdownMenu } from 'bits-ui';
	import { ArchiveRestore, MoreVertical, Trash2 } from '@lucide/svelte';
	import type { ConversationSummary } from '$lib/types/api';
	import DeleteConversationDialog from '$lib/components/DeleteConversationDialog.svelte';
	import { toast } from '$lib/toast.svelte';
	import { setArchived, deleteConversation } from '$lib/conversation-actions';

	let { data } = $props<{ data: { archivedConversations: ConversationSummary[] } }>();

	let busyId = $state<string | null>(null);
	let deleteTargetId = $state<string | null>(null);

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

	async function unarchive(id: string) {
		if (busyId) return;
		busyId = id;
		try {
			await setArchived(id, false);
			await invalidateAll();
		} catch (e) {
			toast.error(`Couldn't unarchive: ${e instanceof Error ? e.message : String(e)}`);
		} finally {
			busyId = null;
		}
	}

	// Delete uses the shared <DeleteConversationDialog> (rendered at the
	// bottom of the markup) so the archived list behaves exactly like
	// the sidebar: a real confirm modal with the orphan-media checkbox,
	// not a bare window.confirm() with no media option. requestDelete
	// opens it; performDelete runs once the user confirms.
	function requestDelete(id: string) {
		if (busyId) return;
		deleteTargetId = id;
	}

	async function performDelete(id: string, deleteMedia: boolean) {
		if (busyId) return;
		busyId = id;
		try {
			await deleteConversation(id, deleteMedia);
			await invalidateAll();
		} catch (e) {
			toast.error(`Couldn't delete: ${e instanceof Error ? e.message : String(e)}`);
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
		<p class="text-xs text-fg-muted">Click to reopen, or use the menu to unarchive or delete.</p>
	</header>

	<div class="flex-1 overflow-y-auto px-4 py-2">
		{#if data.archivedConversations.length === 0}
			<p class="px-2 py-12 text-center text-sm text-fg-muted">No archived conversations.</p>
		{:else}
			<ul class="mx-auto max-w-3xl space-y-0.5">
				{#each data.archivedConversations as c (c.id)}
					<li class="group relative">
						<button
							type="button"
							onclick={() => openConversation(c.id)}
							class="flex w-full items-center justify-between gap-3 rounded-md py-2.5 pl-3 pr-10 text-left text-sm transition hover:bg-surface-sunken/70"
						>
							<span class="min-w-0 flex-1 truncate">{c.title ?? 'Untitled'}</span>
							<span class="shrink-0 text-xs text-fg-muted">{formatDate(c.updatedAt)}</span>
						</button>
						<DropdownMenu.Root>
							<DropdownMenu.Trigger
								disabled={busyId === c.id}
								title="Conversation options"
								aria-label="Options for conversation {c.title ?? 'Untitled'}"
								class="absolute right-1 top-1/2 flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded border-0 bg-transparent text-fg-muted opacity-0 transition hover:bg-surface-sunken hover:text-fg-secondary focus-visible:opacity-100 disabled:opacity-50 group-hover:opacity-100 data-[state=open]:opacity-100"
							>
								<MoreVertical size={14} strokeWidth={2.25} />
							</DropdownMenu.Trigger>
							<DropdownMenu.Portal>
								<DropdownMenu.Content
									sideOffset={4}
									align="end"
									class="z-50 min-w-[160px] overflow-hidden rounded-md border border-border surface-glass gs-pop py-1 shadow-lg"
								>
									<DropdownMenu.Item
										onSelect={() => unarchive(c.id)}
										class="flex cursor-pointer items-center gap-2 px-3 py-1.5 text-sm transition data-[highlighted]:bg-surface-raised"
									>
										<ArchiveRestore size={14} strokeWidth={2.25} />
										<span>Unarchive</span>
									</DropdownMenu.Item>
									<DropdownMenu.Item
										onSelect={() => requestDelete(c.id)}
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

<!--
	Shared delete-confirm dialog — the same modal the sidebar uses, so
	deleting an archived thread offers the orphan-media checkbox too.
-->
<DeleteConversationDialog bind:targetId={deleteTargetId} onconfirm={performDelete} />
