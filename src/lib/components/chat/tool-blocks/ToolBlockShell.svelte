<!--
	Shared collapsible shell for every tool-call block (generic / code / skill).
	Owns the <details>, the open-state, the status badge, and the generated-media
	attachments (rendered OUTSIDE the <details> so a collapsed block still shows
	them). The per-kind components supply the `summary` and `body` snippets.

	The body renders ONLY while the block is open: collapsed → it's removed from
	the DOM, so a large body never builds its subtree or runs markdown/shiki while
	collapsed (e.g. during streaming of an unrelated response). Per-kind
	components must therefore read their expensive $derived ONLY inside their body
	snippet — Svelte 5 deriveds are lazy (computed on read), so an unread one in a
	non-rendered snippet never runs. Reading it in the summary/an effect defeats
	this.
-->
<script lang="ts">
	import { untrack, type Snippet } from 'svelte';
	import { ShieldCheck } from '@lucide/svelte';
	import FileAttachmentChip from '$lib/components/FileAttachmentChip.svelte';
	import type { ToolResultAttachment } from '$lib/chat-render';

	type Status = 'executing' | 'done' | 'error' | 'pending_approval';

	interface Props {
		status: Status;
		attachments?: ToolResultAttachment[];
		/** Icon + label + name; rendered in <summary> before the spacer + badge. */
		summary: Snippet;
		/** Body; rendered only while open (see component header). */
		body: Snippet;
	}

	let { status, attachments, summary, body }: Props = $props();

	// Open by default while executing / errored / awaiting approval — the states
	// the user wants visible; a completed call collapses to metadata.
	const openByDefault = $derived(
		status === 'executing' || status === 'error' || status === 'pending_approval',
	);
	// `isOpen` drives both the <details> (two-way via bind:open, so user toggles
	// are captured) AND the lazy body gate. The effect re-syncs it to
	// openByDefault when STATUS changes (executing→done auto-collapses, etc.). It
	// MUST read ONLY openByDefault, never isOpen — reading isOpen here would loop
	// and clobber user toggles while status is stable.
	// untrack: intentionally seed with the initial openByDefault (the $effect
	// below owns ongoing sync); reading it tracked in an initializer would warn.
	let isOpen = $state(untrack(() => openByDefault));
	$effect(() => {
		isOpen = openByDefault;
	});

	const badgeColorClass = $derived(
		status === 'executing'
			? 'text-warning'
			: status === 'error'
				? 'text-danger'
				: status === 'pending_approval'
					? 'text-warning'
					: 'text-success',
	);
</script>

<details
	bind:open={isOpen}
	class="mt-2 rounded-md border border-border-strong bg-surface-panel text-xs"
>
	<summary class="flex cursor-pointer items-center gap-2 px-2 py-1.5 text-fg-muted select-none">
		{@render summary()}
		<span class="flex-1"></span>
		<!--
			Status badge only shows for non-default states. A completed call renders
			no badge — the disclosure triangle communicates the call exists.
		-->
		{#if status !== 'done'}
			<span
				class="flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-wide {badgeColorClass}"
			>
				{#if status === 'executing'}
					<span class="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-current"></span>
					running
				{:else if status === 'pending_approval'}
					<ShieldCheck size={12} strokeWidth={2.5} aria-hidden="true" />
					needs approval
				{:else}
					error
				{/if}
			</span>
		{/if}
	</summary>
	{#if isOpen}
		<div class="space-y-2 border-t border-border p-2">
			{@render body()}
		</div>
	{/if}
</details>
<!--
	Generated attachments live OUTSIDE the <details> so they stay visible even
	when the block auto-collapses (status: 'done') — a file the model just
	produced is an artifact the user wants to click on immediately.
-->
{#if attachments && attachments.length > 0}
	<div class="mt-2 flex flex-wrap gap-2">
		{#each attachments as att (att.mediaId)}
			{#if att.type === 'image'}
				<img
					src="/api/media/{att.mediaId}/content"
					alt=""
					loading="lazy"
					class="block h-auto max-h-[60vh] w-auto max-w-full rounded-md"
				/>
			{:else if att.type === 'video'}
				<!-- svelte-ignore a11y_media_has_caption -->
				<video
					src="/api/media/{att.mediaId}/content"
					controls
					playsinline
					class="block h-auto max-h-[60vh] w-auto max-w-full rounded-md"
				></video>
			{:else}
				<FileAttachmentChip
					filename={att.filename}
					byteSize={att.byteSize}
					href={`/api/media/${att.mediaId}/content`}
				/>
			{/if}
		{/each}
	</div>
{/if}
