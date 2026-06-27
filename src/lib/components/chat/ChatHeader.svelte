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
		/** The active model's total context window, when known. When set we
		 *  render "N / max tokens (P%)"; when null, just "N tokens". */
		contextWindow?: number | null;
	}

	let { title, assistantLabel, contextTokenCount, contextWindow = null }: Props = $props();

	const tokenFmt = new Intl.NumberFormat();

	// Percent of the window used, when we have both numbers. Clamped at 100
	// (a thread can edge past the reported window via system prompt / tool
	// scaffolding the count doesn't capture).
	const pctUsed = $derived(
		contextWindow && contextWindow > 0
			? Math.min(100, Math.round((contextTokenCount / contextWindow) * 100))
			: null,
	);
</script>

<header class="flex items-center justify-between gap-3 px-4 py-3">
	<div class="min-w-0 flex-1">
		<h1 class="truncate text-sm font-semibold">{title ?? 'Untitled chat'}</h1>
		<div class="flex min-w-0 items-center gap-2 text-xs text-fg-muted">
			<span class="truncate">{assistantLabel}</span>
			{#if contextTokenCount > 0}
				{#if pctUsed !== null}
					<span
						class="flex-shrink-0 tabular-nums"
						class:text-warning={pctUsed >= 90}
						title="Approximate context used after the last response ({pctUsed}% of the model's {tokenFmt.format(
							contextWindow ?? 0,
						)}-token window)"
					>
						· {tokenFmt.format(contextTokenCount)} / {tokenFmt.format(contextWindow ?? 0)} tokens
					</span>
				{:else}
					<span
						class="flex-shrink-0 tabular-nums"
						title="Approximate context size after the last response"
					>
						· {tokenFmt.format(contextTokenCount)} tokens
					</span>
				{/if}
			{/if}
		</div>
	</div>
</header>
