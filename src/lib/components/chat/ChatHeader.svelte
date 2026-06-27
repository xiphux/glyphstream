<!--
	Chat page header: conversation title, the assistant/model label, an
	approximate context-token count after the most recent response, and a
	"Compact" action that summarizes older history to free up context.
-->
<script lang="ts">
	import { FoldVertical } from '@lucide/svelte';

	interface Props {
		title: string | null;
		assistantLabel: string;
		/** Approximate context size (tokensIn + tokensOut of the latest
		 *  assistant message). Hidden when 0. */
		contextTokenCount: number;
		/** The active model's total context window, when known. When set we
		 *  render "N / max tokens (P%)"; when null, just "N tokens". */
		contextWindow?: number | null;
		/** Manual-compaction handler. When omitted, no Compact button renders
		 *  (e.g. image/video conversations). */
		onCompact?: () => void;
		/** Disable the Compact button when there isn't enough history to fold. */
		canCompact?: boolean;
		/** True while a compaction is in flight — shows a "Compacting…" state. */
		compacting?: boolean;
	}

	let {
		title,
		assistantLabel,
		contextTokenCount,
		contextWindow = null,
		onCompact,
		canCompact = false,
		compacting = false,
	}: Props = $props();

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
	{#if onCompact}
		<button
			type="button"
			onclick={onCompact}
			disabled={!canCompact || compacting}
			title={canCompact
				? 'Summarize earlier messages to free up context. The originals stay in the thread.'
				: 'Not enough conversation history to compact yet.'}
			class="flex flex-shrink-0 items-center gap-1.5 rounded-md border border-border px-2 py-1 text-xs text-fg-muted transition hover:bg-surface-raised disabled:opacity-40 disabled:hover:bg-transparent"
		>
			<FoldVertical class="h-3.5 w-3.5 {compacting ? 'animate-pulse' : ''}" />
			<span class="hidden sm:inline">{compacting ? 'Compacting…' : 'Compact'}</span>
		</button>
	{/if}
</header>
