<!--
	Chat page header: conversation title, the assistant/model label, and
	an approximate context-token count after the most recent response.
	Read-only — purely informational, no interactivity.
-->
<script lang="ts">
	interface Props {
		title: string | null;
		assistantLabel: string;
		/** Approximate context size (tokensIn + tokensOut of the latest
		 *  assistant message). Hidden when 0. */
		contextTokenCount: number;
	}

	let { title, assistantLabel, contextTokenCount }: Props = $props();

	const tokenFmt = new Intl.NumberFormat();
</script>

<header class="flex items-center justify-between gap-3 px-4 py-3">
	<div class="min-w-0 flex-1">
		<h1 class="truncate text-sm font-semibold">{title ?? 'Untitled chat'}</h1>
		<div class="flex min-w-0 items-center gap-2 text-xs text-neutral-500">
			<span class="truncate">{assistantLabel}</span>
			{#if contextTokenCount > 0}
				<span
					class="flex-shrink-0 tabular-nums"
					title="Approximate context size after the last response"
				>
					· {tokenFmt.format(contextTokenCount)} tokens
				</span>
			{/if}
		</div>
	</div>
</header>
