<!--
	Chat page header: conversation title + the assistant/model label. Pure
	identity — the context-budget readout and the Compact action moved down to
	`ContextBudgetBar`, right above the composer where they're actually used.
-->
<script lang="ts">
	interface Props {
		title: string | null;
		assistantLabel: string;
	}

	let { title, assistantLabel }: Props = $props();
</script>

<header class="flex items-center justify-between gap-3 px-4 py-3">
	<div class="min-w-0 flex-1">
		<h1 class="truncate text-sm font-semibold">{title ?? 'Untitled chat'}</h1>
		<div class="flex min-w-0 items-center gap-2 text-xs text-fg-muted">
			<span class="truncate">{assistantLabel}</span>
		</div>
	</div>
</header>
