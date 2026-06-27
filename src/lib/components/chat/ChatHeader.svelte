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

	// The budget readout, when we know the window — bundled so `max` is a
	// proven number at the use site (no `?? 0` papering over a null that can't
	// occur here). `pct` is clamped at 100: a thread can edge past the reported
	// window via system prompt / tool scaffolding the count doesn't capture.
	const budget = $derived(
		contextWindow && contextWindow > 0
			? {
					max: contextWindow,
					pct: Math.min(100, Math.round((contextTokenCount / contextWindow) * 100)),
				}
			: null,
	);
</script>

<header class="flex items-center justify-between gap-3 px-4 py-3">
	<div class="min-w-0 flex-1">
		<h1 class="truncate text-sm font-semibold">{title ?? 'Untitled chat'}</h1>
		<div class="flex min-w-0 items-center gap-2 text-xs text-fg-muted">
			<span class="truncate">{assistantLabel}</span>
			{#if contextTokenCount > 0}
				{#if budget !== null}
					<span
						class="flex-shrink-0 tabular-nums"
						class:text-warning={budget.pct >= 90}
						title="Approximate context used after the last response ({budget.pct}% of the model's {tokenFmt.format(
							budget.max,
						)}-token window)"
					>
						· {tokenFmt.format(contextTokenCount)} / {tokenFmt.format(budget.max)} tokens
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
