<!--
	The live streaming-response bubble at the bottom of the message list.
	Purely presentational — the page owns the SSE-driven in-flight state
	and passes the derived blocks + status down. Before the first
	text/tool_call segment arrives, shows a "Thinking…/Generating…"
	placeholder with optional status badge, progress %, and elapsed time;
	once blocks land, RenderBlocks takes over (identical to the persisted
	view).
-->
<script lang="ts">
	import RenderBlocks from './RenderBlocks.svelte';
	import type { RenderBlock } from '$lib/chat-render';
	import type { ApprovalAction } from '$lib/approval-workflow';

	interface Props {
		blocks: RenderBlock[];
		/** Bubble header label (the assistant/model name). */
		assistantLabel: string;
		/** Placeholder verb: "Thinking" / "Generating image" / "Generating video". */
		label: string;
		status: string | null;
		progress: number | null;
		elapsedSeconds: number;
		onImageClick: (mediaId: string) => void;
		openingLightboxFor?: string | null;
		approvalDecisions?: Map<string, ApprovalAction>;
		approvalBusy?: boolean;
		onApprovalSelect?: (toolCallId: string, action: ApprovalAction) => void;
		/** True when the immediately-preceding message is a persisted
		 *  assistant turn — drops the top rounded corner + role label so
		 *  the live bubble fuses with that prior message visually. Used
		 *  during the approval-resume flow: the prior turn halted on a
		 *  tool_call, the resumed turn streams in here, and after
		 *  invalidate the two will be merged in the persisted view. */
		mergeWithPrev?: boolean;
	}

	let {
		blocks,
		assistantLabel,
		label,
		status,
		progress,
		elapsedSeconds,
		onImageClick,
		openingLightboxFor = null,
		approvalDecisions,
		approvalBusy = false,
		onApprovalSelect,
		mergeWithPrev = false,
	}: Props = $props();
</script>

<article
	class={[
		'min-w-0 bg-surface-raised px-4 text-sm',
		mergeWithPrev ? 'rounded-t-none pt-1' : 'rounded-t-2xl pt-3',
		'rounded-b-2xl pb-3',
	]}
>
	{#if !mergeWithPrev}
		<div class="text-[11px] font-medium tracking-wide opacity-60">{assistantLabel}</div>
	{/if}
	<RenderBlocks
		{blocks}
		{onImageClick}
		{openingLightboxFor}
		{approvalDecisions}
		{approvalBusy}
		{onApprovalSelect}
	/>
	{#if blocks.length === 0}
		<!-- Pre-first-token placeholder: thinking dots + optional
		     progress/elapsed indicators. Once any text or tool_call
		     segment lands, RenderBlocks takes over. -->
		<div class="mt-1 flex items-center gap-2 text-fg-muted">
			<span>{label}</span>
			<span class="inline-flex gap-1">
				<span class="animate-pulse">·</span>
				<span class="animate-pulse [animation-delay:120ms]">·</span>
				<span class="animate-pulse [animation-delay:240ms]">·</span>
			</span>
			{#if status && status !== 'in_progress'}
				<span
					class="rounded bg-surface-sunken px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-fg-secondary"
				>
					{status}
				</span>
			{/if}
			{#if progress !== null}
				<span class="font-mono text-xs tabular-nums">{progress.toFixed(0)}%</span>
			{/if}
			{#if elapsedSeconds >= 0.3}
				<span class="font-mono text-xs tabular-nums">{elapsedSeconds.toFixed(1)}s</span>
			{/if}
		</div>
	{/if}
</article>
