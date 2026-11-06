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
	import AssistantAvatar from './AssistantAvatar.svelte';
	import MessageReaction from './MessageReaction.svelte';
	import TextingBubbles from './TextingBubbles.svelte';
	import { messageToBlocks, type RenderBlock, type ToolResultEntry } from '#lib/chat-render.js';
	import type { ChatMessage, Scene } from '#lib/types/api.js';
	import { sceneMarker } from '#lib/scenes.js';
	import SceneDivider from './SceneDivider.svelte';
	import type { ApprovalAction } from '#lib/approval-workflow.js';
	import { withoutCheckInMarkers, type TextingPhotos } from '#lib/texting.js';
	import { splitAtPhotos, type PhotoSegment } from '#lib/texting-photos.js';
	import PhotoSlot from './PhotoSlot.svelte';
	import type { PendingCheckInNote } from '#lib/check-ins.js';
	import CheckInNote from './CheckInNote.svelte';

	interface Props {
		message: ChatMessage;
		toolResultsByCallId: Map<string, ToolResultEntry>;
		userLabel: string;
		assistantLabel: string;
		/** Avatar for THIS message's assistant, already resolved by
		 *  `assistantIdentityForMessage` — null for a user/tool row, for a
		 *  message re-attributed to another model, and for a conversation whose
		 *  model has no avatar. */
		assistantAvatarMediaId?: string | null;
		mergeWithPrev: boolean;
		mergeWithNext: boolean;
		onImageClick: (mediaId: string) => void;
		openingLightboxFor?: string | null;
		approvalDecisions?: Map<string, ApprovalAction>;
		approvalBusy?: boolean;
		onApprovalSelect?: (toolCallId: string, action: ApprovalAction) => void;
		/** The emoji the assistant reacted to THIS message with, when it did and
		 *  this is a user row. Resolved on the active branch by
		 *  `buildRenderedConversation`, so a retry's sibling brings its own and
		 *  `‹ 2/3 ›` swaps them. Null/absent means no reaction. */
		reaction?: string | null;
		/** Canvas cards to render at the bottom of this bubble — set only on the
		 *  last message of an assistant group, hoisted there by the page so the
		 *  artifact reads as the turn's result rather than buried mid-reply. */
		bottomCanvasCards?: RenderBlock[];
		onOpenCanvas?: (artifactId: string | null) => void;
		/** A character chat's scene as this message opens (`#lib/scenes.ts`):
		 *  an assistant row renders as texts or in-person prose
		 *  (TextingBubbles) instead of one bubble, and a user row that changes
		 *  scene shows where. Absent for a standard chat. */
		scene?: Scene;
		/** This reply's photos, and what can be done with them — set where the
		 *  chat may send photos. A character reply draws them among its texts or
		 *  its scene; a standard one in its bubble, where each `[photo: …]` was
		 *  (see PhotoSlot). */
		photos?: TextingPhotos;
		/** The avatar portraits drawn from this reply, as one picture (its
		 *  versions under index 0) — set where any are, or are drawing. Shown at
		 *  the end of the reply, whose description they were drawn from. */
		portrait?: TextingPhotos;
		/** This reply's pending check-in, if it set one: a note under it. */
		checkIn?: PendingCheckInNote;
	}

	let {
		message,
		toolResultsByCallId,
		userLabel,
		assistantLabel,
		assistantAvatarMediaId = null,
		mergeWithPrev,
		mergeWithNext,
		onImageClick,
		openingLightboxFor = null,
		approvalDecisions,
		approvalBusy = false,
		onApprovalSelect,
		reaction = null,
		bottomCanvasCards = [],
		onOpenCanvas,
		scene,
		photos,
		portrait,
		checkIn,
	}: Props = $props();

	const roleLabel = $derived(
		message.role === 'user'
			? userLabel
			: message.role === 'assistant'
				? assistantLabel
				: message.role,
	);

	// Assistant rows only — a tool row borrows neither the label nor the face.
	const avatarMediaId = $derived(message.role === 'assistant' ? assistantAvatarMediaId : null);

	// A standard reply cut around its photos, where the chat may send them, so
	// each is drawn where the model put it. Anything else is one run, as ever.
	// A user row in a character chat: its scene markers (the composer's switch
	// puts one on top) show as a divider above the bubble, not as words in it.
	const userScenes = $derived.by(() => {
		if (!scene || message.role !== 'user') return null;
		const switches: Scene[] = [];
		const parts = message.parts.map((p) => {
			if (p.type !== 'text') return p;
			const kept = p.text.split(/\n\s*\n/).filter((para) => {
				const to = sceneMarker({ text: para });
				if (to) switches.push(to);
				return !to;
			});
			return { ...p, text: kept.join('\n\n').trim() };
		});
		return switches.length ? { switches, message: { ...message, parts } } : null;
	});

	const segments = $derived.by((): PhotoSegment[] => {
		const blocks = messageToBlocks(userScenes?.message ?? message, toolResultsByCallId);
		if (message.role !== 'assistant') return [{ kind: 'blocks', blocks }];
		const shown = withoutCheckInMarkers(blocks);
		return photos ? splitAtPhotos(shown) : [{ kind: 'blocks', blocks: shown }];
	});
</script>

{#if scene && message.role === 'assistant'}
	<article class="min-w-0">
		<TextingBubbles
			blocks={messageToBlocks(message, toolResultsByCallId)}
			{scene}
			{assistantLabel}
			{assistantAvatarMediaId}
			{onImageClick}
			{openingLightboxFor}
			{approvalDecisions}
			{approvalBusy}
			{onApprovalSelect}
			{photos}
			photosOn={!!photos}
			{checkIn}
		/>
		{#if portrait}
			<div class="mt-1.5">
				<PhotoSlot
					index={0}
					description="{assistantLabel}'s portrait"
					photos={portrait}
					{onImageClick}
					{openingLightboxFor}
					portrait
				/>
			</div>
		{/if}
		{#each bottomCanvasCards as block (block.type === 'tool_call' ? block.toolCallId : '')}
			{#if block.type === 'tool_call'}
				<CanvasCard result={block.result} onOpen={onOpenCanvas} />
			{/if}
		{/each}
	</article>
{:else}
	{#if userScenes}
		<!-- Only a real change: a switch to the scene already in effect says
		     nothing. -->
		{#each userScenes.switches.filter((to, i, all) => to !== (i === 0 ? scene : all[i - 1])) as to, i (i)}
			<SceneDivider scene={to} />
		{/each}
	{/if}
	<article
		class={[
			// `relative` anchors the reaction badge, which hangs outside the bubble's
			// bottom-left corner. Harmless on the rows that never carry one.
			'relative min-w-0 px-4 text-sm',
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
			<!-- The avatar lives INSIDE the label row's mergeWithPrev guard: a
		     multi-iteration tool turn renders as one visual bubble, so repeating
		     the portrait mid-bubble would read as a second speaker. -->
			<div class="flex items-center gap-1.5">
				{#if avatarMediaId}
					<AssistantAvatar mediaId={avatarMediaId} label={roleLabel} onClick={onImageClick} />
				{/if}
				<div class="text-[11px] font-medium tracking-wide opacity-60">{roleLabel}</div>
			</div>
		{/if}
		{#each segments as segment, i (i)}
			{#if segment.kind === 'photo'}
				<PhotoSlot
					index={segment.index}
					description={segment.description}
					{photos}
					{onImageClick}
					{openingLightboxFor}
					inBubble
				/>
			{:else}
				<RenderBlocks
					blocks={segment.blocks}
					{onImageClick}
					{openingLightboxFor}
					{approvalDecisions}
					{approvalBusy}
					{onApprovalSelect}
				/>
			{/if}
		{/each}
		{#if portrait}
			<PhotoSlot
				index={0}
				description="{assistantLabel}'s portrait"
				photos={portrait}
				{onImageClick}
				{openingLightboxFor}
				inBubble
				portrait
			/>
		{/if}
		{#if reaction && message.role === 'user'}
			<MessageReaction emoji={reaction} reactorLabel={assistantLabel} />
		{/if}
		{#each bottomCanvasCards as block (block.type === 'tool_call' ? block.toolCallId : '')}
			{#if block.type === 'tool_call'}
				<CanvasCard result={block.result} onOpen={onOpenCanvas} />
			{/if}
		{/each}
	</article>
	{#if checkIn}
		<CheckInNote {checkIn} />
	{/if}
{/if}
