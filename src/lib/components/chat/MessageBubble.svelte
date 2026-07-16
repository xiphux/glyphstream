<!--
	Static (non-editing) render of one persisted chat message. The role
	drives the bubble styling (user = accent-tinted right-aligned, assistant =
	raised, tool = warning-tinted). mergeWithPrev/mergeWithNext collapse consecutive
	assistant rows from a multi-iteration tool turn into one visual bubble
	(shared corners, no duplicate role label) — see computeMergeFlags in
	chat-render.ts.

	Body rendering is delegated to <RenderBlocks> so the persisted view and
	the in-flight view stay pixel-identical.
-->
<script lang="ts">
	import RenderBlocks from './RenderBlocks.svelte';
	import CanvasCard from './CanvasCard.svelte';
	import { messageToBlocks, type RenderBlock, type ToolResultEntry } from '$lib/chat-render';
	import type { ChatMessage } from '$lib/types/api';
	import type { ApprovalAction } from '$lib/approval-workflow';

	interface Props {
		message: ChatMessage;
		toolResultsByCallId: Map<string, ToolResultEntry>;
		userLabel: string;
		assistantLabel: string;
		mergeWithPrev: boolean;
		mergeWithNext: boolean;
		onImageClick: (mediaId: string) => void;
		openingLightboxFor?: string | null;
		approvalDecisions?: Map<string, ApprovalAction>;
		approvalBusy?: boolean;
		onApprovalSelect?: (toolCallId: string, action: ApprovalAction) => void;
		/** Canvas cards to render at the bottom of this bubble — set only on the
		 *  last message of an assistant group, hoisted there by the page so the
		 *  artifact reads as the turn's result rather than buried mid-reply. */
		bottomCanvasCards?: RenderBlock[];
		onOpenCanvas?: (artifactId: string | null) => void;
	}

	let {
		message,
		toolResultsByCallId,
		userLabel,
		assistantLabel,
		mergeWithPrev,
		mergeWithNext,
		onImageClick,
		openingLightboxFor = null,
		approvalDecisions,
		approvalBusy = false,
		onApprovalSelect,
		bottomCanvasCards = [],
		onOpenCanvas,
	}: Props = $props();

	const roleLabel = $derived(
		message.role === 'user'
			? userLabel
			: message.role === 'assistant'
				? assistantLabel
				: message.role,
	);
</script>

<article
	class={[
		'min-w-0 px-4 text-sm',
		message.role === 'user'
			? 'ml-auto max-w-[85%] bg-accent/15'
			: message.role === 'assistant'
				? 'bg-surface-raised'
				: 'bg-warning/10',
		mergeWithPrev ? 'rounded-t-none pt-1' : 'rounded-t-2xl pt-3',
		mergeWithNext ? 'rounded-b-none pb-1' : 'rounded-b-2xl pb-3',
	]}
>
	{#if !mergeWithPrev}
		<div class="text-[11px] font-medium tracking-wide opacity-60">{roleLabel}</div>
	{/if}
	<RenderBlocks
		blocks={messageToBlocks(message, toolResultsByCallId)}
		{onImageClick}
		{openingLightboxFor}
		{approvalDecisions}
		{approvalBusy}
		{onApprovalSelect}
	/>
	{#each bottomCanvasCards as block (block.type === 'tool_call' ? block.toolCallId : '')}
		{#if block.type === 'tool_call'}
			<CanvasCard result={block.result} onOpen={onOpenCanvas} />
		{/if}
	{/each}
</article>
