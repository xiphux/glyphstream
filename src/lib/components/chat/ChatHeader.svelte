<!--
	Chat page header: the conversation title on one row, plus a "Private" badge on
	the right for a private (incognito) chat. The model name lives in each assistant
	bubble and in the composer's model picker, so it isn't repeated here — and a
	single header model name would be misleading in a multi-model thread anyway. The
	context-budget readout + Compact action are in `ContextBudgetBar`, above the
	composer.
-->
<script lang="ts">
	import { VenetianMask } from '@lucide/svelte';

	interface Props {
		title: string | null;
		/** Private (incognito) chat — shows the badge; the whole app also re-tints. */
		private?: boolean;
	}

	let { title, private: isPrivate = false }: Props = $props();
</script>

<header class="flex items-center gap-3 px-4 py-3">
	<h1 class="min-w-0 flex-1 truncate text-sm font-semibold">{title ?? 'Untitled chat'}</h1>
	{#if isPrivate}
		<span
			class="flex shrink-0 items-center gap-1.5 rounded-full bg-accent/12 px-2.5 py-1 text-xs font-medium text-accent"
			title="Private chat — nothing from this chat is saved to memories, summaries, or search, and personalization / web / MCP tools are off"
		>
			<VenetianMask size={13} strokeWidth={2.25} />
			<span>Private</span>
		</span>
	{/if}
</header>
