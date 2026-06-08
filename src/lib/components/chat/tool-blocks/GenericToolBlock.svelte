<!--
	Generic tool-call block: pretty-printed JSON args + result/error, or the
	pending-approval prompt (only MCP tools reach pending_approval today, and they
	render generically). The shell owns the collapse/badge/attachments.
-->
<script lang="ts">
	import { Check, ShieldCheck, ShieldX } from '@lucide/svelte';
	import ToolBlockShell from './ToolBlockShell.svelte';
	import ToolResultSection from './ToolResultSection.svelte';
	import { prettyJson, type ToolResultAttachment } from '$lib/chat-render';
	import type { ApprovalAction } from '$lib/approval-workflow';

	type Status = 'executing' | 'done' | 'error' | 'pending_approval';

	interface Props {
		toolName: string;
		argumentsJson: string;
		result?: string;
		isError?: boolean;
		status: Status;
		attachments?: ToolResultAttachment[];
		toolCallId?: string;
		decision?: ApprovalAction | null;
		approvalBusy?: boolean;
		onApprovalSelect?: (toolCallId: string, action: ApprovalAction) => void;
	}

	let {
		toolName,
		argumentsJson,
		result,
		isError,
		status,
		attachments,
		toolCallId,
		decision = null,
		approvalBusy = false,
		onApprovalSelect,
	}: Props = $props();

	// Read only inside the body snippet so it doesn't compute while collapsed.
	const prettyArgs = $derived(prettyJson(argumentsJson));

	function approvalButtonClass(action: ApprovalAction): string {
		const base =
			'inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-[11px] font-medium transition disabled:cursor-not-allowed disabled:opacity-50';
		const selected = decision === action;
		switch (action) {
			case 'allow':
				return `${base} ${selected ? 'border-success/50 bg-success/10 text-success' : 'border-border bg-surface-panel text-fg hover:bg-surface-raised'}`;
			case 'allow_always':
				return `${base} ${selected ? 'border-info/50 bg-info/10 text-info' : 'border-border bg-surface-panel text-fg hover:bg-surface-raised'}`;
			case 'reject':
				return `${base} ${selected ? 'border-danger/50 bg-danger/10 text-danger' : 'border-border bg-surface-panel text-fg hover:bg-surface-raised'}`;
		}
	}
</script>

<ToolBlockShell {status} {attachments}>
	{#snippet summary()}
		<span class="text-[10px] font-semibold uppercase tracking-wider opacity-70">Tool</span>
		<span class="font-mono text-xs text-fg-secondary">{toolName}</span>
	{/snippet}
	{#snippet body()}
		{#if prettyArgs}
			<div>
				<div class="mb-0.5 text-[10px] font-medium uppercase tracking-wider text-fg-muted">
					Arguments
				</div>
				<pre
					class="overflow-x-auto whitespace-pre-wrap break-words font-mono text-[11px] text-fg-secondary">{prettyArgs}</pre>
			</div>
		{/if}
		{#if status === 'pending_approval'}
			<div class="rounded border-l-2 border-warning pl-2">
				<div class="mb-0.5 text-[10px] font-medium uppercase tracking-wider text-warning">
					Awaiting your approval
				</div>
				<div class="flex flex-wrap gap-1.5 pb-1 pt-0.5">
					<button
						type="button"
						class={approvalButtonClass('allow')}
						disabled={approvalBusy || !onApprovalSelect || !toolCallId}
						onclick={() => toolCallId && onApprovalSelect && onApprovalSelect(toolCallId, 'allow')}
					>
						<Check size={12} strokeWidth={2.5} aria-hidden="true" />
						Allow
					</button>
					<button
						type="button"
						class={approvalButtonClass('allow_always')}
						disabled={approvalBusy || !onApprovalSelect || !toolCallId}
						onclick={() =>
							toolCallId && onApprovalSelect && onApprovalSelect(toolCallId, 'allow_always')}
					>
						<ShieldCheck size={12} strokeWidth={2.5} aria-hidden="true" />
						Allow always
					</button>
					<button
						type="button"
						class={approvalButtonClass('reject')}
						disabled={approvalBusy || !onApprovalSelect || !toolCallId}
						onclick={() => toolCallId && onApprovalSelect && onApprovalSelect(toolCallId, 'reject')}
					>
						<ShieldX size={12} strokeWidth={2.5} aria-hidden="true" />
						Reject
					</button>
				</div>
			</div>
		{:else}
			<ToolResultSection {result} {isError} />
		{/if}
	{/snippet}
</ToolBlockShell>
