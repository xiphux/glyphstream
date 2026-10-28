<!--
	An assistant reply in the 'texting' reply style: one bubble per text, as
	`textingItems` splits it, under the name (and face) of whoever sent it. A
	header shows wherever the sender changes, so a run of texts from one person
	carries one name, as in a messaging app. The first text always gets one, even
	when this row continues a tool turn from the row above: speakers start over
	with the assistant in each row (it's a separate model reply), so leaving the
	header off would show its text under whoever spoke last above.

	A `[photo: …]` text is a photo the sender took. Until it's developed it shows
	as a placeholder with its description (and, while the reply is the latest
	thing in the thread, a Develop button); once developed it disappears from
	here, because the photo itself arrives as a row of its own after the reply —
	which this component also draws, as the bare picture a phone shows.

	While the reply is still arriving (`typing`), the text being written shows
	as a typing indicator and appears whole once the next one starts. Partial
	text in a bubble reads like a document loading, not like someone texting.

	A `[later …]` text sets a check-in. It's a note to the app, not a text, so it
	shows only while that check-in is pending — as a quiet line saying when, with
	a way to call it off.

	Anything else — tool calls, other images, reasoning — keeps its standard
	rendering in a bubble of its own.

	Shared by MessageBubble and InFlightBubble so the live reply and the stored
	one split the same way.
-->
<script lang="ts">
	import { Camera, RefreshCw } from '@lucide/svelte';
	import RenderBlocks from './RenderBlocks.svelte';
	import CheckInNote from './CheckInNote.svelte';
	import AssistantAvatar from './AssistantAvatar.svelte';
	import type { Snippet } from 'svelte';
	import { splitCanvasCards, type RenderBlock } from '#lib/chat-render.js';
	import type { ApprovalAction } from '#lib/approval-workflow.js';
	import { cssAspectRatio } from '#lib/aspect-ratio.js';
	import { codeCopyClicks, withCodeCopyButtons } from '#lib/code-copy.js';
	import { speakerHue, textingItems, type TextingItem, type TextingPhotos } from '#lib/texting.js';
	import type { PendingCheckInNote } from '#lib/check-ins.js';

	interface Props {
		blocks: RenderBlock[];
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
		checkIn?: PendingCheckInNote;
	}

	let {
		blocks,
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
		checkIn,
	}: Props = $props();

	// Each item paired with whether it opens a new sender's run. `undefined`
	// as the starting sender makes the first text always differ from it.
	const rows = $derived.by(() => {
		let prev: string | null | undefined = undefined;
		// Without the successful canvas edits, which the caller renders as cards
		// at the bottom: left in, a canvas-only reply would draw an empty bubble.
		// Without the photos that have arrived, too, which show further down.
		// Only the last marker sets the check-in, and only while it's pending.
		const all: Array<TextingItem | { kind: 'typing'; speaker: string | null }> = textingItems(
			splitCanvasCards(blocks).body,
			assistantLabel,
		);
		// Still being written: a text (or a marker, half-typed) at the end of a
		// live reply. Tool calls and the like show as they go, as ever. A
		// finished check-in marker has no sender and is never shown, so typing
		// it would flash the preset's name under someone else's run.
		const last = all.at(-1);
		if (
			typing &&
			last &&
			last.kind !== 'blocks' &&
			last.kind !== 'sent-photo' &&
			last.kind !== 'later'
		) {
			all[all.length - 1] = { kind: 'typing', speaker: 'speaker' in last ? last.speaker : null };
		}
		const items = all.filter((item, i, all) =>
			item.kind === 'later'
				? !!checkIn && !all.slice(i + 1).some((x) => x.kind === 'later')
				: item.kind !== 'photo' || !photos?.developed.has(item.index),
		);
		if (items.length === 0 && pending) items.push({ kind: 'text', speaker: null, text: '' });
		return items.map((item) => {
			if (item.kind === 'blocks' || item.kind === 'later') return { item, header: false };
			// A delivered photo is a row of its own, after texts that may have
			// changed sender, so it always says who it's from.
			const header = item.kind === 'sent-photo' || item.speaker !== prev;
			prev = item.speaker;
			return { item, header };
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
	{#each rows as { item, header }, i (i)}
		{#if item.kind === 'later'}
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
				<div
					class="flex w-60 max-w-[85%] flex-col gap-1.5 rounded-2xl border border-dashed border-border-strong bg-surface-raised px-3.5 py-2.5"
				>
					<div class="flex items-center gap-1.5 text-xs font-medium text-fg-muted">
						<Camera class="size-3.5" aria-hidden="true" />
						Photo
					</div>
					<p class="line-clamp-4 text-sm italic text-fg-secondary">{item.description}</p>
					{#if photos?.developing === item.index}
						<p class="text-xs text-fg-muted">Developing…</p>
					{:else if photos?.onDevelop}
						{@const index = item.index}
						<button
							type="button"
							onclick={() => photos?.onDevelop?.(index)}
							class="self-start rounded-md bg-surface-inverse px-3 py-1 text-xs font-medium text-fg-inverse transition hover:opacity-90"
						>
							Develop
						</button>
					{/if}
				</div>
			{:else if item.kind === 'sent-photo'}
				{@const mediaId = item.block.mediaId}
				<div class="relative w-64 max-w-[75%]">
					<button
						type="button"
						onclick={() => onImageClick(mediaId)}
						aria-label="Open photo"
						disabled={openingLightboxFor === mediaId}
						class="block w-full overflow-hidden rounded-2xl p-0 transition disabled:opacity-60"
					>
						<img
							src="/api/media/{mediaId}/display"
							alt={item.block.alt ?? 'Photo'}
							loading="lazy"
							style:aspect-ratio={cssAspectRatio(item.block)}
							class="block h-auto max-h-[70vh] w-full object-cover"
						/>
					</button>
					{#if photos?.onRedevelop}
						<button
							type="button"
							onclick={() => photos?.onRedevelop?.()}
							aria-label="Develop again"
							title="Develop again"
							class="absolute top-2 right-2 rounded-full bg-black/55 p-1.5 text-white transition hover:bg-black/70"
						>
							<RefreshCw class="size-3.5" aria-hidden="true" />
						</button>
					{/if}
				</div>
			{:else}
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
			{/if}
		{/if}
	{/each}
</div>
