<!--
	The attachment-thumbnail strip shown above a composer (and the inline
	message editor). Renders nothing when the store has no items.

	Extracted from three byte-identical copies — the new-chat composer,
	the chat composer, and the inline editor — so a future change to the
	thumbnail UX (a retry-failed-upload button, a size label, …) lands in
	one place. `class` is appended to the wrapper for the small
	per-context spacing difference (composers want px-1, the inline
	editor wants mb-2).
-->
<script lang="ts">
	import { AlertCircle, X } from '@lucide/svelte';
	import type { AttachmentStore } from '$lib/attachments.svelte';

	let {
		attachments,
		class: className = ''
	}: {
		attachments: AttachmentStore;
		class?: string;
	} = $props();
</script>

{#if attachments.items.length > 0}
	<div
		class="flex flex-wrap gap-2 border-b border-neutral-200 pb-2 dark:border-neutral-800 {className}"
	>
		{#each attachments.items as a (a.clientId)}
			<div
				class="group/thumb relative h-16 w-16 shrink-0 overflow-hidden rounded-md border border-neutral-200 bg-neutral-100 dark:border-neutral-700 dark:bg-neutral-800"
				title={a.error ?? a.contentType}
			>
				<img
					src={a.objectUrl}
					alt=""
					class="h-full w-full object-cover {a.status === 'uploading'
						? 'opacity-60'
						: a.status === 'error'
							? 'opacity-40'
							: ''}"
				/>
				{#if a.status === 'uploading'}
					<div
						class="absolute inset-0 flex items-center justify-center bg-black/20 text-white"
					>
						<div class="h-4 w-4 animate-spin rounded-full border-2 border-white border-t-transparent"></div>
					</div>
				{:else if a.status === 'error'}
					<div
						class="absolute inset-0 flex items-center justify-center bg-red-600/40 text-white"
					>
						<AlertCircle size={20} strokeWidth={2} />
					</div>
				{/if}
				<button
					type="button"
					onclick={() => attachments.remove(a.clientId)}
					aria-label="Remove attachment"
					title="Remove"
					class="absolute right-0.5 top-0.5 flex h-5 w-5 items-center justify-center rounded-full bg-neutral-900/80 text-white opacity-0 transition group-hover/thumb:opacity-100 hover:bg-neutral-900 focus-visible:opacity-100"
				>
					<X size={12} strokeWidth={2.5} />
				</button>
			</div>
		{/each}
	</div>
{/if}
