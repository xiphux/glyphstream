<!--
	A compaction summary rendered as a collapsed, expandable divider sitting
	between the earlier (now-summarized) messages and the verbatim tail. The
	real messages around it stay visible inline — this block is plumbing for
	the model's context, so it's collapsed by default and the user can open it
	to read what was condensed.
-->
<script lang="ts">
	import { ChevronRight, FoldVertical } from '@lucide/svelte';
	import type { ChatMessage } from '$lib/types/api';

	let { message }: { message: ChatMessage } = $props();

	let open = $state(false);

	const text = $derived(
		message.parts
			.filter((p): p is { type: 'text'; text: string } => p.type === 'text')
			.map((p) => p.text)
			.join(''),
	);
</script>

<div class="my-3 overflow-hidden rounded-lg border border-border bg-surface-sunken/50 text-xs">
	<button
		type="button"
		onclick={() => (open = !open)}
		aria-expanded={open}
		class="flex w-full items-center gap-2 px-3 py-2 text-fg-muted transition hover:bg-surface-raised"
	>
		<FoldVertical class="h-3.5 w-3.5 flex-shrink-0" />
		<span class="font-medium whitespace-nowrap text-fg">Context summary</span>
		<!-- The descriptor is supplementary; drop it on narrow screens (where it
		     only truncated anyway) so the label stays on one line. -->
		<span class="hidden truncate text-fg-muted sm:inline"
			>— earlier messages condensed to free up context</span
		>
		<ChevronRight
			class="ml-auto h-3.5 w-3.5 flex-shrink-0 transition-transform {open ? 'rotate-90' : ''}"
		/>
	</button>
	{#if open}
		<div class="border-t border-border px-3 py-2">
			{#if message.contentHtml}
				<!-- Server-rendered markdown; {@html} safe (markdown-it html=false). -->
				<div class="gs-prose">{@html message.contentHtml}</div>
			{:else}
				<div class="whitespace-pre-wrap">{text}</div>
			{/if}
		</div>
	{/if}
</div>
