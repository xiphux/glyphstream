<!--
	An assistant reply in a character chat, scene by scene (`#lib/scenes.ts`).
	It opens in `scene`, and a `[texting]` / `[in person]` marker in it moves
	on, drawn as a divider where it is.

	Texting: one bubble per text, as `textingItems` splits it, under the name
	(and face) of whoever sent it. A
	header shows wherever the sender changes, so a run of texts from one person
	carries one name, as in a messaging app. The first text always gets one, even
	when this row continues a tool turn from the row above: speakers start over
	with the assistant in each row (it's a separate model reply), so leaving the
	header off would show its text under whoever spoke last above.

	A `[photo: …]` text is a photo the sender took. Until it's developed it shows
	as a placeholder with its description and a Develop button; once developed,
	the photo shows right there, as the bare picture a phone shows — with arrows
	between its versions, and buttons to develop it again or remove this one.

	While the reply is still arriving (`typing`), the text being written shows
	as a typing indicator and appears whole once the next one starts. Partial
	text in a bubble reads like a document loading, not like someone texting.

	A `[later …]` text sets a check-in. It's a note to the app, not a text, so it
	shows only while that check-in is pending — as a quiet line saying when, with
	a way to call it off.

	In person: the same paragraphs as prose, with no bubbles and no typing
	indicator — nobody is typing. Actions, which the model sets in *asterisks*,
	are muted, so what's said stands out from what's done. Speakers and photos
	work as they do in texts.

	Anything else — tool calls, other images, reasoning — keeps its standard
	rendering in a bubble of its own.

	Shared by MessageBubble and InFlightBubble so the live reply and the stored
	one split the same way.
-->
<script lang="ts">
	import RenderBlocks from './RenderBlocks.svelte';
	import CheckInNote from './CheckInNote.svelte';
	import AssistantAvatar from './AssistantAvatar.svelte';
	import PhotoSlot from './PhotoSlot.svelte';
	import type { Snippet } from 'svelte';
	import { splitCanvasCards, type RenderBlock } from '#lib/chat-render.js';
	import type { ApprovalAction } from '#lib/approval-workflow.js';
	import { codeCopyClicks, withCodeCopyButtons } from '#lib/code-copy.js';
	import { speakerHue, textingItems, type TextingItem, type TextingPhotos } from '#lib/texting.js';
	import type { PendingCheckInNote } from '#lib/check-ins.js';
	import type { Scene } from '#lib/types/api.js';
	import SceneDivider from './SceneDivider.svelte';

	interface Props {
		blocks: RenderBlock[];
		/** The scene the reply opens in. */
		scene?: Scene;
		assistantLabel: string;
		assistantAvatarMediaId?: string | null;
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
		/** A live reply: the text still being written shows as a typing
		 *  indicator, and arrives whole once the next one starts (or the reply
		 *  ends) — the way a messaging app shows a text. */
		typing?: boolean;
		photos?: TextingPhotos;
		/** The chat sends photos, so a `[photo: …]` is one. Off, it's just a text
		 *  — as it is in a standard reply — rather than a photo nothing can
		 *  develop. */
		photosOn?: boolean;
		checkIn?: PendingCheckInNote;
	}

	let {
		blocks,
		scene = 'texting',
		assistantLabel,
		assistantAvatarMediaId = null,
		onImageClick,
		openingLightboxFor = null,
		approvalDecisions,
		approvalBusy = false,
		onApprovalSelect,
		codeCopy = true,
		pending,
		typing = false,
		photos,
		photosOn = true,
		checkIn,
	}: Props = $props();

	type Shown = TextingItem | { kind: 'typing'; speaker: string | null };

	// Each item paired with the scene it's in and whether it opens a new
	// sender's run. `undefined` as the starting sender makes the first text
	// always differ from it.
	const rows = $derived.by(() => {
		// Without the successful canvas edits, which the caller renders as cards
		// at the bottom: left in, a canvas-only reply would draw an empty bubble.
		const parsed: Shown[] = textingItems(splitCanvasCards(blocks).body, assistantLabel).map(
			(item) =>
				item.kind === 'photo' && !photosOn
					? { kind: 'text', speaker: item.speaker, text: `[photo: ${item.description}]` }
					: item,
		);
		// The scene each item is in, and whether it changes it.
		let at = scene;
		const all = parsed.map((item) => {
			const from = at;
			if (item.kind === 'scene') at = item.scene;
			return { item, scene: from };
		});
		// Still being written: a text (or a marker, half-typed) at the end of a
		// live reply. Tool calls and the like show as they go, as ever. A
		// finished check-in or scene marker has no sender and is never shown, so
		// typing it would flash the preset's name under someone else's run. In
		// person nobody is typing: the prose shows as it arrives, all but a
		// marker being written, which would flash as words.
		const last = all.at(-1);
		if (typing && last && 'speaker' in last.item) {
			if (last.scene === 'texting') {
				all[all.length - 1] = { ...last, item: { kind: 'typing', speaker: last.item.speaker } };
			} else if (
				last.item.kind === 'text' &&
				/^(?:<p>)?\[/.test('html' in last.item ? last.item.html : last.item.text)
			) {
				all.pop();
			}
		}
		// Only the last marker sets the check-in, and only while it's pending.
		const items = all.filter(
			({ item }, i, all) =>
				(item.kind !== 'later' ||
					(!!checkIn && !all.slice(i + 1).some((x) => x.item.kind === 'later'))) &&
				// A switch to the scene already in effect says nothing.
				(item.kind !== 'scene' || item.scene !== all[i].scene),
		);
		if (items.length === 0 && pending) {
			items.push({ item: { kind: 'text', speaker: null, text: '' }, scene });
		}
		let prev: string | null | undefined = undefined;
		return items.map(({ item, scene }) => {
			if (item.kind === 'scene') {
				// A new scene starts its senders over: the first line after the
				// divider says who it is.
				prev = undefined;
				return { item, scene, header: false };
			}
			if (item.kind === 'blocks' || item.kind === 'later') return { item, scene, header: false };
			const header = item.speaker !== prev;
			prev = item.speaker;
			return { item, scene, header };
		});
	});
</script>

{#snippet senderHeader(speaker: string | null, first: boolean)}
	<div class={['flex items-center gap-1.5', !first && 'mt-2']}>
		{#if speaker === null && assistantAvatarMediaId}
			<AssistantAvatar
				mediaId={assistantAvatarMediaId}
				label={assistantLabel}
				onClick={onImageClick}
			/>
		{:else}
			{@const name = speaker ?? assistantLabel}
			<!-- A preset with no avatar gets an initial like any other speaker,
			     so its texts are told apart from theirs at a glance. -->
			<span
				aria-hidden="true"
				class="flex size-8 shrink-0 items-center justify-center rounded-full text-xs font-semibold text-white"
				style:background-color="hsl({speakerHue(name)} 50% 45%)"
			>
				{Array.from(name)[0]?.toUpperCase()}
			</span>
		{/if}
		<div class="text-[11px] font-medium tracking-wide opacity-60">
			{speaker ?? assistantLabel}
		</div>
	</div>
{/snippet}

<div class="flex min-w-0 flex-col items-start gap-1 text-sm">
	{#each rows as { item, scene: here, header }, i (i)}
		{#if item.kind === 'scene'}
			<SceneDivider scene={item.scene} />
		{:else if item.kind === 'later'}
			{#if checkIn}
				<CheckInNote {checkIn} />
			{/if}
		{:else if item.kind === 'blocks'}
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
		{:else}
			{#if header}
				{@render senderHeader(item.speaker, i === 0)}
			{/if}
			{#if item.kind === 'typing'}
				<div
					role="status"
					aria-label="{item.speaker ?? assistantLabel} is typing"
					class="inline-flex gap-1 rounded-2xl bg-surface-raised px-3.5 py-3 text-fg-muted"
				>
					<span class="size-1.5 animate-pulse rounded-full bg-current"></span>
					<span class="size-1.5 animate-pulse rounded-full bg-current [animation-delay:150ms]"
					></span>
					<span class="size-1.5 animate-pulse rounded-full bg-current [animation-delay:300ms]"
					></span>
				</div>
			{:else if item.kind === 'photo'}
				<PhotoSlot
					index={item.index}
					description={item.description}
					{photos}
					{onImageClick}
					{openingLightboxFor}
				/>
			{:else}
				<div
					class={[
						'min-w-0',
						here === 'texting'
							? 'max-w-[85%] rounded-2xl bg-surface-raised px-3.5 py-2'
							: 'w-full py-0.5 [&_em]:text-fg-muted',
					]}
				>
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
			{/if}
		{/if}
	{/each}
</div>
