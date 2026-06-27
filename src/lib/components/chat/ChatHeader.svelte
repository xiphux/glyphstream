<!--
	Chat page header: just the conversation title, on one row. The model name
	lives in each assistant bubble and in the composer's model picker, so it isn't
	repeated here — and a single header model name would be misleading in a
	multi-model thread anyway. The context-budget readout + Compact action are in
	`ContextBudgetBar`, above the composer.
-->
<script lang="ts">
	interface Props {
		title: string | null;
	}

	let { title }: Props = $props();
</script>

<header class="flex items-center gap-3 px-4 py-3">
	<h1 class="min-w-0 flex-1 truncate text-sm font-semibold">{title ?? 'Untitled chat'}</h1>
</header>
