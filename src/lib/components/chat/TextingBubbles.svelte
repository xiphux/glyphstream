<!--
	An assistant reply in the 'texting' reply style: one bubble per text, as
	`textingItems` splits it, under the name (and face) of whoever sent it. A
	header shows wherever the sender changes, so a run of texts from one person
	carries one name, as in a messaging app. Anything that isn't text — tool
	calls, images, reasoning — keeps its standard rendering in a bubble of its own.

	Shared by MessageBubble and InFlightBubble so the live reply and the stored
	one split the same way.
-->
<script lang="ts">
	import RenderBlocks from './RenderBlocks.svelte';
	import AssistantAvatar from './AssistantAvatar.svelte';
	import type { Snippet } from 'svelte';
	import { splitCanvasCards, type RenderBlock } from '#lib/chat-render.js';
	import type { ApprovalAction } from '#lib/approval-workflow.js';
	import { codeCopyClicks, withCodeCopyButtons } from '#lib/code-copy.js';
	import { speakerHue, textingItems } from '#lib/texting.js';

	interface Props {
		blocks: RenderBlock[];
		assistantLabel: string;
		assistantAvatarMediaId?: string | null;
		/** False when this reply continues the one above it (a multi-iteration
		 *  tool turn), so its first text by the assistant needs no header. */
		showHeader: boolean;
		onImageClick: (mediaId: string) => void;
		openingLightboxFor?: string | null;
		approvalDecisions?: Map<string, ApprovalAction>;
		approvalBusy?: boolean;
		onApprovalSelect?: (toolCallId: string, action: ApprovalAction) => void;
		/** See RenderBlocks — off while streaming. */
		codeCopy?: boolean;
		/** Shown in a bubble from the assistant while there is nothing to show
		 *  yet (a live reply before its first token). */
		pending?: Snippet;
	}

	let {
		blocks,
		assistantLabel,
		assistantAvatarMediaId = null,
		showHeader,
		onImageClick,
		openingLightboxFor = null,
		approvalDecisions,
		approvalBusy = false,
		onApprovalSelect,
		codeCopy = true,
		pending,
	}: Props = $props();

	// Each item paired with whether it opens a new sender's run. `undefined`
	// as the starting sender makes the first text always differ from it.
	const rows = $derived.by(() => {
		let prev: string | null | undefined = showHeader ? undefined : null;
		// Without the successful canvas edits, which the caller renders as cards
		// at the bottom: left in, a canvas-only reply would draw an empty bubble.
		const items = textingItems(splitCanvasCards(blocks).body, assistantLabel);
		if (items.length === 0 && pending) items.push({ kind: 'text', speaker: null, text: '' });
		return items.map((item) => {
			if (item.kind !== 'text') return { item, header: false };
			const header = item.speaker !== prev;
			prev = item.speaker;
			return { item, header };
		});
	});
</script>

<div class="flex min-w-0 flex-col items-start gap-1 text-sm">
	{#each rows as { item, header }, i (i)}
		{#if item.kind === 'text'}
			{#if header}
				<div class={['flex items-center gap-1.5', i > 0 && 'mt-2']}>
					{#if item.speaker === null}
						{#if assistantAvatarMediaId}
							<AssistantAvatar
								mediaId={assistantAvatarMediaId}
								label={assistantLabel}
								onClick={onImageClick}
							/>
						{/if}
					{:else}
						<span
							aria-hidden="true"
							class="flex size-8 shrink-0 items-center justify-center rounded-full text-xs font-semibold text-white"
							style:background-color="hsl({speakerHue(item.speaker)} 50% 45%)"
						>
							{Array.from(item.speaker)[0].toUpperCase()}
						</span>
					{/if}
					<div class="text-[11px] font-medium tracking-wide opacity-60">
						{item.speaker ?? assistantLabel}
					</div>
				</div>
			{/if}
			<div class="max-w-[85%] min-w-0 rounded-2xl bg-surface-raised px-3.5 py-2">
				{#if pending && blocks.length === 0}
					{@render pending()}
				{:else if 'html' in item}
					<div class="gs-prose" {@attach codeCopy && codeCopyClicks}>
						<!-- eslint-disable-next-line svelte/no-at-html-tags -->
						{@html codeCopy ? withCodeCopyButtons(item.html) : item.html}
					</div>
				{:else}
					<div class="whitespace-pre-wrap break-words">{item.text}</div>
				{/if}
			</div>
		{:else}
			<div class="w-full min-w-0 rounded-2xl bg-surface-raised px-4 pt-2 pb-3">
				<RenderBlocks
					blocks={item.blocks}
					{onImageClick}
					{openingLightboxFor}
					{approvalDecisions}
					{approvalBusy}
					{onApprovalSelect}
					{codeCopy}
				/>
			</div>
		{/if}
	{/each}
</div>
