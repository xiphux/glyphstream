<script lang="ts">
	/**
	 * Folded tool-call display block. One per `tool_call` part on an
	 * assistant message; the matching `tool_result` (looked up from the
	 * sibling-map of folded role:'tool' messages) supplies the result
	 * + status.
	 *
	 * Layout mirrors the reasoning <details> block in the chat page:
	 * native disclosure triangle, muted small-caps label, monospace
	 * function name, status badge on the right. Collapsed by default
	 * when the call is done; auto-expanded while executing.
	 */
	import type { Snippet } from 'svelte';
	import { Check, ShieldCheck, ShieldX } from '@lucide/svelte';
	import FileAttachmentChip from '$lib/components/FileAttachmentChip.svelte';
	import type { ToolResultAttachment } from '$lib/chat-render';

	type Status = 'executing' | 'done' | 'error' | 'pending_approval';
	type ApprovalAction = 'allow' | 'allow_always' | 'reject';

	interface Props {
		toolName: string;
		argumentsJson: string;
		/** undefined while the tool is still executing. */
		result?: string;
		isError?: boolean;
		status: Status;
		/** Optional slot for callers that want to add a status suffix
		 *  (elapsed time, etc.). Renders inside the badge. */
		badgeSuffix?: Snippet;
		/** Only meaningful when status === 'pending_approval'. The
		 *  toolCallId so the click handler can identify which pending row
		 *  to update. */
		toolCallId?: string;
		/** Whichever decision the user has staged for this call (when N
		 *  pending tools are on screen, each independently records its
		 *  user-chosen action; the chat page auto-submits the batch once
		 *  every pending tool has a non-null decision). */
		decision?: ApprovalAction | null;
		approvalBusy?: boolean;
		onApprovalSelect?: (toolCallId: string, action: ApprovalAction) => void;
		/** Media the tool produced — rendered as inline image / video /
		 *  download chip after the result, so the user sees the artifact
		 *  attached to the same block as the call that produced it. */
		attachments?: ToolResultAttachment[];
	}

	let {
		toolName,
		argumentsJson,
		result,
		isError,
		status,
		badgeSuffix,
		toolCallId,
		decision = null,
		approvalBusy = false,
		onApprovalSelect,
		attachments,
	}: Props = $props();

	// Pretty-print JSON when it parses; otherwise the raw string. Cheap
	// even on large args because the args themselves are typically tiny
	// (a single function call's argument payload).
	function prettyJson(s: string | undefined): string {
		if (!s) return '';
		try {
			return JSON.stringify(JSON.parse(s), null, 2);
		} catch {
			return s;
		}
	}

	const prettyArgs = $derived(prettyJson(argumentsJson));
	const prettyResult = $derived(prettyJson(result));

	// Collapsed by default when the call is done — tool details are
	// metadata for the curious, not primary content. Auto-expanded
	// while executing so the user sees activity. Errors stay expanded
	// because the user typically WANTS to see what went wrong. Pending-
	// approval rows stay expanded so the prompt + args are visible.
	const openByDefault = $derived(
		status === 'executing' || status === 'error' || status === 'pending_approval',
	);

	const badgeColorClass = $derived(
		status === 'executing'
			? 'text-amber-700 dark:text-amber-400'
			: status === 'error'
				? 'text-red-700 dark:text-red-400'
				: status === 'pending_approval'
					? 'text-amber-700 dark:text-amber-400'
					: 'text-emerald-700 dark:text-emerald-400',
	);

	function approvalButtonClass(action: ApprovalAction): string {
		const base =
			'inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-[11px] font-medium transition disabled:cursor-not-allowed disabled:opacity-50';
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

<details
	open={openByDefault}
	class="mt-2 rounded-md border border-border-strong bg-surface-panel text-xs"
>
	<summary class="flex cursor-pointer items-center gap-2 px-2 py-1.5 text-fg-muted select-none">
		<span class="text-[10px] font-semibold uppercase tracking-wider opacity-70">Tool</span>
		<span class="font-mono text-xs text-fg-secondary">{toolName}</span>
		<span class="flex-1"></span>
		<!--
			Status badge only shows for non-default states. A completed call
			renders no badge — the disclosure triangle on the summary line
			communicates the call exists; users assume done unless told
			otherwise. Errors and in-progress stay visible because they're
			the cases the user actually wants to notice at a glance.
		-->
		{#if status !== 'done'}
			<span
				class="flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-wide {badgeColorClass}"
			>
				{#if status === 'executing'}
					<span class="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-current"></span>
					running
				{:else if status === 'pending_approval'}
					<ShieldCheck size={12} strokeWidth={2.5} aria-hidden="true" />
					needs approval
				{:else}
					error
				{/if}
				{#if badgeSuffix}<span class="opacity-70 normal-case">{@render badgeSuffix()}</span>{/if}
			</span>
		{/if}
	</summary>
	<div class="space-y-2 border-t border-border p-2">
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
			<div class="rounded border-l-2 border-amber-400 pl-2 dark:border-amber-500/70">
				<div
					class="mb-0.5 text-[10px] font-medium uppercase tracking-wider text-amber-700 dark:text-amber-300"
				>
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
		{:else if result !== undefined}
			<div class="rounded {isError ? 'border-l-2 border-red-400 pl-2 dark:border-red-500' : ''}">
				<div
					class="mb-0.5 text-[10px] font-medium uppercase tracking-wider {isError
						? 'text-red-600 dark:text-red-400'
						: 'text-fg-muted'}"
				>
					{isError ? 'Error' : 'Result'}
				</div>
				<pre
					class="overflow-x-auto whitespace-pre-wrap break-words font-mono text-[11px] text-fg-secondary">{prettyResult}</pre>
			</div>
		{/if}
		{#if attachments && attachments.length > 0}
			<div class="mt-2 flex flex-wrap gap-2">
				{#each attachments as att (att.mediaId)}
					{#if att.type === 'image'}
						<img
							src="/api/media/{att.mediaId}/content"
							alt=""
							loading="lazy"
							class="block h-auto max-h-[60vh] w-auto max-w-full rounded-md"
						/>
					{:else if att.type === 'video'}
						<!-- svelte-ignore a11y_media_has_caption -->
						<video
							src="/api/media/{att.mediaId}/content"
							controls
							class="block h-auto max-h-[60vh] w-auto max-w-full rounded-md"
						></video>
					{:else}
						<FileAttachmentChip
							filename={att.filename}
							byteSize={att.byteSize}
							href={`/api/media/${att.mediaId}/content`}
						/>
					{/if}
				{/each}
			</div>
		{/if}
	</div>
</details>
