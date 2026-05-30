<!--
	Inline approval card rendered when an MCP tool the user hasn't yet
	trusted is awaiting a decision. Three buttons: Allow (one-time), Allow
	Always (persist to trustedMcpTools so future calls skip the prompt),
	Reject (the model sees a declined-error result and continues).

	Pure presentation — the parent collects {toolCallId → action}
	decisions across all pending tools in the turn and posts the batch to
	/api/conversations/[id]/tool-approval. Disabled while the parent's
	submitting state is true.
-->
<script lang="ts">
	import { ShieldCheck, ShieldX, Check } from '@lucide/svelte';

	type Action = 'allow' | 'allow_always' | 'reject';

	interface Props {
		toolCallId: string;
		toolName: string;
		displayLabel?: string;
		category?: string;
		args: string;
		decision: Action | null;
		busy: boolean;
		onSelect: (toolCallId: string, action: Action) => void;
	}

	let {
		toolCallId,
		toolName,
		displayLabel,
		category,
		args,
		decision,
		busy,
		onSelect
	}: Props = $props();

	const serverId = $derived(
		category && category.startsWith('mcp:') ? category.slice('mcp:'.length) : null
	);

	const prettyLabel = $derived(displayLabel ?? toolName);

	const prettyArgs = $derived(formatArgs(args));

	function formatArgs(raw: string): string {
		if (!raw || raw.length === 0) return '{}';
		try {
			return JSON.stringify(JSON.parse(raw), null, 2);
		} catch {
			return raw;
		}
	}

	function buttonClass(action: Action): string {
		const base =
			'inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-sm font-medium transition disabled:cursor-not-allowed disabled:opacity-50';
		const selected = decision === action;
		switch (action) {
			case 'allow':
				return `${base} ${selected ? 'border-emerald-400 bg-emerald-50 text-emerald-900 dark:border-emerald-500/60 dark:bg-emerald-950/40 dark:text-emerald-200' : 'border-border bg-surface-panel text-fg hover:bg-surface-raised'}`;
			case 'allow_always':
				return `${base} ${selected ? 'border-blue-400 bg-blue-50 text-blue-900 dark:border-blue-500/60 dark:bg-blue-950/40 dark:text-blue-200' : 'border-border bg-surface-panel text-fg hover:bg-surface-raised'}`;
			case 'reject':
				return `${base} ${selected ? 'border-rose-400 bg-rose-50 text-rose-900 dark:border-rose-500/60 dark:bg-rose-950/40 dark:text-rose-200' : 'border-border bg-surface-panel text-fg hover:bg-surface-raised'}`;
		}
	}
</script>

<div class="rounded-lg border border-amber-300/70 bg-amber-50/60 p-3 text-sm dark:border-amber-500/40 dark:bg-amber-950/30">
	<div class="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-amber-800 dark:text-amber-300">
		<ShieldCheck size={14} strokeWidth={2.25} aria-hidden="true" />
		<span>Approval required</span>
	</div>
	<div class="mt-2 flex flex-wrap items-baseline gap-x-2 text-fg">
		<span class="font-medium">{prettyLabel}</span>
		{#if serverId}
			<span class="text-xs text-fg-muted">from {serverId}</span>
		{/if}
	</div>
	{#if prettyArgs && prettyArgs !== '{}'}
		<details class="group mt-2 text-xs">
			<summary class="cursor-pointer select-none text-fg-muted group-open:text-fg">
				Arguments
			</summary>
			<pre class="mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-md border border-border bg-surface-sunken p-2 font-mono text-xs">{prettyArgs}</pre>
		</details>
	{/if}
	<div class="mt-3 flex flex-wrap gap-2" data-tool-call-id={toolCallId}>
		<button
			type="button"
			class={buttonClass('allow')}
			disabled={busy}
			onclick={() => onSelect(toolCallId, 'allow')}
		>
			<Check size={14} strokeWidth={2.5} aria-hidden="true" />
			Allow
		</button>
		<button
			type="button"
			class={buttonClass('allow_always')}
			disabled={busy}
			onclick={() => onSelect(toolCallId, 'allow_always')}
		>
			<ShieldCheck size={14} strokeWidth={2.5} aria-hidden="true" />
			Allow always
		</button>
		<button
			type="button"
			class={buttonClass('reject')}
			disabled={busy}
			onclick={() => onSelect(toolCallId, 'reject')}
		>
			<ShieldX size={14} strokeWidth={2.5} aria-hidden="true" />
			Reject
		</button>
	</div>
</div>
