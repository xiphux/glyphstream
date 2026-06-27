<!--
	Context-budget bar shown just above the composer — where "do I have room for
	what I'm about to send?" is actually asked. Pairs the approximate context
	readout with the Compact action that frees it up. Rendered (and hidden) by the
	chat page; see `showBudgetBar` there.
-->
<script lang="ts">
	import { FoldVertical } from '@lucide/svelte';

	interface Props {
		/** Approximate context size (tokensIn + tokensOut of the latest assistant
		 *  message). Hidden when 0. */
		contextTokenCount: number;
		/** The active model's total context window, when known → "N / max · P%". */
		contextWindow?: number | null;
		onCompact: () => void;
		/** Enables the Compact button; disabled when there's nothing to fold. */
		canCompact?: boolean;
		/** True while a compaction is in flight — shows a "Compacting…" state. */
		compacting?: boolean;
	}

	let {
		contextTokenCount,
		contextWindow = null,
		onCompact,
		canCompact = false,
		compacting = false,
	}: Props = $props();

	const tokenFmt = new Intl.NumberFormat();

	const budget = $derived(
		contextWindow && contextWindow > 0
			? {
					max: contextWindow,
					pct: Math.min(100, Math.round((contextTokenCount / contextWindow) * 100)),
				}
			: null,
	);
</script>

<div class="mb-2 flex items-center justify-between gap-3 px-1 text-xs text-fg-muted">
	<span class="min-w-0 truncate tabular-nums">
		{#if contextTokenCount > 0}
			{#if budget !== null}
				<span
					class:text-warning={budget.pct >= 90}
					title="Approximate context used after the last response ({budget.pct}% of the model's {tokenFmt.format(
						budget.max,
					)}-token window)"
				>
					{tokenFmt.format(contextTokenCount)} / {tokenFmt.format(budget.max)} tokens · {budget.pct}%
				</span>
			{:else}
				<span title="Approximate context size after the last response">
					{tokenFmt.format(contextTokenCount)} tokens
				</span>
			{/if}
		{/if}
	</span>
	<button
		type="button"
		onclick={onCompact}
		disabled={!canCompact || compacting}
		title={canCompact
			? 'Summarize earlier messages to free up context. The originals stay in the thread.'
			: 'Not enough conversation history to compact yet.'}
		class="flex flex-shrink-0 items-center gap-1.5 rounded-md border border-border px-2 py-1 transition hover:bg-surface-raised disabled:opacity-40 disabled:hover:bg-transparent"
	>
		<FoldVertical class="h-3.5 w-3.5 {compacting ? 'animate-pulse' : ''}" />
		<span>{compacting ? 'Compacting…' : 'Compact'}</span>
	</button>
</div>
