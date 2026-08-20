<!--
	The conversation-avatar menu, hung off the chat header.

	One entry point for a two-step flow, which is why it's a menu and not two
	buttons: step 1 asks the model to describe an image of itself, step 2 draws
	the description. Keeping both here (rather than putting step 2 on a message)
	means neither step clutters the thread, and the menu can say plainly that
	step 2 works from the latest reply.

	The gap between the steps is the point, not an implementation detail — you
	read the description before spending a generation on it, and on a host where
	the chat model and the image model share a GPU it puts real time between the
	two calls.

	Step 2 opens the review dialog rather than drawing straight away — the reply
	often needs trimming before it's a usable image prompt, and the model and
	enhancer choices belong next to the prompt they apply to (see
	AvatarDrawDialog). This menu deliberately holds neither.

	Presentational: every decision (which model, whether a source reply exists,
	what the status says) arrives as a prop.
-->
<script lang="ts">
	import { Popover } from 'bits-ui';
	import { Sparkles } from '@lucide/svelte';

	interface Props {
		/** Whether any image model is configured. The menu doesn't need to know
		 *  WHICH — choosing one belongs with the prompt in the draw dialog, where
		 *  both are reviewed together — only whether step 2 can lead anywhere. */
		hasImageModel: boolean;
		/** The conversation's current avatar, shown so the menu reflects state
		 *  rather than being a pair of blind buttons. */
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
	}: Props = $props();
</script>

<Popover.Root>
	<Popover.Trigger
		aria-label="Avatar for this conversation"
		title="Generate an avatar for this conversation"
		class="flex size-8 shrink-0 items-center justify-center rounded-md text-fg-muted transition hover:bg-surface-sunken hover:text-fg-secondary data-[state=open]:bg-surface-sunken data-[state=open]:text-fg-secondary"
	>
		<Sparkles size={15} strokeWidth={2.25} />
	</Popover.Trigger>
	<Popover.Portal>
		<Popover.Content
			sideOffset={6}
			align="end"
			class="z-overlay w-72 rounded-md border border-border surface-glass gs-pop p-3 shadow-lg"
		>
			<div class="mb-2 flex items-center gap-2">
				{#if avatarMediaId}
					<img
						src="/api/media/{avatarMediaId}/thumbnail"
						alt=""
						class="size-8 shrink-0 rounded-full object-cover ring-1 ring-black/10 dark:ring-white/15"
					/>
				{/if}
				<p class="text-xs font-semibold uppercase tracking-wide text-fg-muted">
					{avatarMediaId ? 'Conversation avatar' : 'No avatar yet'}
				</p>
			</div>

			<ol class="space-y-2.5">
				<li>
					<button
						type="button"
						disabled={busy}
						onclick={onDescribe}
						class="w-full rounded-md border border-border px-3 py-1.5 text-left text-xs transition hover:bg-surface-sunken disabled:opacity-50"
					>
						1. Ask for a description
					</button>
					<p class="mt-1 text-[11px] leading-snug text-fg-muted">
						Puts the request in the composer so you can edit it before sending.
					</p>
				</li>
				<li>
					<button
						type="button"
						disabled={busy || !hasSource || !hasImageModel}
						onclick={onGenerate}
						class="w-full rounded-md bg-surface-inverse px-3 py-1.5 text-xs font-medium text-fg-inverse transition hover:opacity-90 disabled:opacity-50"
					>
						{alreadyDrawn ? '2. Draw it again' : '2. Draw the latest reply'}
					</button>
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

			{#if status}
				<p class="mt-2 border-t border-border pt-2 text-[11px] text-fg-secondary">{status}</p>
			{/if}
		</Popover.Content>
	</Popover.Portal>
</Popover.Root>
