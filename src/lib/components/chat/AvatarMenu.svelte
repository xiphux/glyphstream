<!--
	The conversation's avatar, in the header, doubling as the menu that makes it.

	The avatar IS the trigger. It's a property of the conversation, not of any one
	message, so it belongs in the conversation's identity row next to the title —
	where every messaging app puts the other party's picture. That also makes the
	control hard to miss without spending a corner on an icon whose meaning you'd
	have to guess, and gives the empty state somewhere useful to live: a
	placeholder in the shape of the thing it makes is a better invitation than a
	sparkle floating on its own.

	Deliberately NOT a hover-revealed overlay on the avatar. Tailwind v4 wraps
	`hover:` / `group-hover:` in `@media (hover: hover)`, so a control hidden by
	`opacity-0` and revealed on group-hover is permanently invisible on touch
	while keeping its hit area — see CLAUDE.md's `can-hover:` note and
	`hover-reveal-touch-reachable.test.ts`. Click-opens-menu behaves the same on
	both.

	One entry point for a two-step flow: step 1 asks the model to describe an
	image of itself, step 2 draws the description. The gap between them is the
	point, not an implementation detail — you read the description before
	spending a generation on it, and on a host where the chat model and the image
	model share a GPU it puts real time between the two calls.

	Step 2 opens the review dialog rather than drawing straight away, and the
	model + enhancer choices live there, beside the prompt they apply to (see
	AvatarDrawDialog). This menu deliberately holds neither.

	Presentational: every decision (whether a source reply exists, what the
	status says) arrives as a prop.
-->
<script lang="ts">
	import { Popover } from 'bits-ui';
	import { Sparkles } from '@lucide/svelte';

	interface Props {
		/** Whether any image model is configured. The menu doesn't need to know
		 *  WHICH — choosing one belongs with the prompt in the draw dialog, where
		 *  both are reviewed together — only whether step 2 can lead anywhere. */
		hasImageModel: boolean;
		/** The conversation's effective avatar (its own, else its preset's). Null
		 *  renders the placeholder, which is what advertises the feature. */
		avatarMediaId: string | null;
		/** False when there's no assistant reply to draw from yet — step 2 is
		 *  offered but disabled, so the sequence stays legible. */
		hasSource: boolean;
		/** The reply step 2 would draw has already been drawn on this branch, so
		 *  the action is a re-roll rather than a first attempt. Only changes the
		 *  wording: the call is identical either way, and the new portrait lands
		 *  beside the old one as a sibling. */
		alreadyDrawn: boolean;
		/** Non-null while a generation is running: 'Queued…', 'Drawing…'. */
		status: string | null;
		/** True while any turn is in flight — both steps are unavailable. */
		busy: boolean;
		onDescribe: () => void;
		onGenerate: () => void;
		/** Opens the avatar in the media lightbox. Offered here so the full-size
		 *  view is reachable from the one place the avatar always is, instead of
		 *  by scrolling back to find the bubble that produced it. */
		onViewFullSize: () => void;
	}

	let {
		hasImageModel,
		avatarMediaId,
		hasSource,
		alreadyDrawn,
		status,
		busy,
		onDescribe,
		onGenerate,
		onViewFullSize,
	}: Props = $props();

	// Centred, like every other button in the app — `text-left` is for rows you
	// pick from (model picker, autocomplete, search results), not for buttons.
	// Step 2 is styled as the primary action so it can't share this wholesale;
	// keep the box identical (padding, width, alignment) and vary only the fill.
	const itemClass =
		'w-full rounded-md border border-border px-3 py-1.5 text-xs transition hover:bg-surface-sunken disabled:opacity-50';
</script>

<Popover.Root>
	<Popover.Trigger
		aria-label={status
			? `Avatar for this conversation — ${status}`
			: 'Avatar for this conversation'}
		title={status ?? 'Avatar for this conversation'}
		class="relative shrink-0 rounded-full transition hover:opacity-85 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-border-focus"
	>
		{#if status}
			<!-- Progress rides the avatar rather than holding the dialog open: the
			     generation is a background errand, and this is the spot the result
			     lands in, so it's where "still working" belongs. Kept clickable —
			     the menu shows the same status in words. -->
			<span
				class="absolute -inset-1 animate-spin rounded-full border-2 border-accent border-t-transparent"
				aria-hidden="true"
			></span>
		{/if}
		{#if avatarMediaId}
			<img
				src="/api/media/{avatarMediaId}/thumbnail"
				alt=""
				width="40"
				height="40"
				class="size-10 rounded-full object-cover ring-1 ring-black/10 dark:ring-white/15"
			/>
		{:else}
			<span
				class="flex size-10 items-center justify-center rounded-full border border-dashed border-border-strong text-fg-muted"
			>
				<Sparkles size={16} strokeWidth={2} class={status ? 'animate-pulse' : ''} />
			</span>
		{/if}
	</Popover.Trigger>
	<Popover.Portal>
		<Popover.Content
			sideOffset={6}
			align="start"
			class="z-overlay w-72 rounded-md border border-border surface-glass gs-pop p-3 shadow-lg"
		>
			<p class="mb-2 text-xs font-semibold uppercase tracking-wide text-fg-muted">
				{avatarMediaId ? 'Conversation avatar' : 'No avatar yet'}
			</p>

			<ol class="space-y-2.5">
				<li>
					<!-- Popover.Close so the menu gets out of its own way: step 1 hands
					     off to the composer and step 2 opens a modal, and neither is
					     usable with this still covering it. -->
					<Popover.Close disabled={busy} onclick={onDescribe} class={itemClass}>
						1. Ask for a description
					</Popover.Close>
					<p class="mt-1 text-[11px] leading-snug text-fg-muted">
						Puts the request in the composer so you can edit it before sending.
					</p>
				</li>
				<li>
					<Popover.Close
						disabled={busy || !hasSource || !hasImageModel}
						onclick={onGenerate}
						class="w-full rounded-md bg-surface-inverse px-3 py-1.5 text-xs font-medium text-fg-inverse transition hover:opacity-90 disabled:opacity-50"
					>
						{alreadyDrawn ? '2. Draw it again' : '2. Draw the latest reply'}
					</Popover.Close>
					<p class="mt-1 text-[11px] leading-snug text-fg-muted">
						{#if !hasImageModel}
							No image model is configured.
						{:else if !hasSource}
							Send the description request first.
						{:else if alreadyDrawn}
							Same description again — the new one becomes the avatar, and the ‹ › arrows on the
							bubble compare them.
						{:else}
							Shows the image prompt for review, then draws it and makes it this conversation's
							avatar.
						{/if}
					</p>
				</li>
			</ol>

			{#if avatarMediaId}
				<div class="mt-2.5 border-t border-border pt-2.5">
					<Popover.Close onclick={onViewFullSize} class={itemClass}>View full size</Popover.Close>
				</div>
			{/if}

			{#if status}
				<p class="mt-2 border-t border-border pt-2 text-[11px] text-fg-secondary">{status}</p>
			{/if}
		</Popover.Content>
	</Popover.Portal>
</Popover.Root>
