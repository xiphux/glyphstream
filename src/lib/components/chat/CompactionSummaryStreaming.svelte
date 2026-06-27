<!--
	The in-flight summary block shown while a manual compaction streams. Mirrors
	the reasoning-block pattern: an expanded box with the summary text flowing in,
	which is replaced by the persisted collapsed CompactionSummary divider once
	`compaction_done` lands and the thread refetches.
-->
<script lang="ts">
	import { FoldVertical } from '@lucide/svelte';

	let { text }: { text: string } = $props();
</script>

<div class="my-3 overflow-hidden rounded-lg border border-border bg-surface-sunken/50 text-xs">
	<div class="flex items-center gap-2 px-3 py-2 text-fg-muted">
		<FoldVertical class="h-3.5 w-3.5 flex-shrink-0 animate-pulse" />
		<span class="font-medium text-fg">Summarizing context…</span>
	</div>
	{#if text}
		<div class="gs-prose border-t border-border px-3 py-2 whitespace-pre-wrap">{text}</div>
	{/if}
</div>
