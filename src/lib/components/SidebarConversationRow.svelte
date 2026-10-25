<!--
	One conversation in the sidebar's Recents: the link (with its generating /
	queued / title-pending / private marker), the inline rename field that
	replaces it, and the options menu. The `<li>` and its flip animation stay in
	the layout: `animate:` has to sit on the keyed each block's direct child.
-->
<script lang="ts">
	import { DropdownMenu } from 'bits-ui';
	import {
		Archive,
		CalendarClock,
		MoreVertical,
		Pencil,
		Trash2,
		VenetianMask,
	} from '@lucide/svelte';
	import { MAX_CONVERSATION_TITLE_LENGTH, type ConversationSummary } from '#lib/types/api.js';
	import type { ConversationUiActions } from '#lib/conversation-ui-actions.svelte.js';
	import type { GenerationActivity } from '#lib/generating-conversations.svelte.js';

	let {
		c,
		href,
		active,
		activity,
		titlePending,
		renaming,
		convUi,
		menuOpen,
		onMenuOpenChange,
	}: {
		c: ConversationSummary;
		href: string;
		/** The current page, or the one being navigated to. */
		active: boolean;
		activity: GenerationActivity | null;
		titlePending: boolean;
		renaming: boolean;
		convUi: ConversationUiActions;
		menuOpen: boolean;
		onMenuOpenChange: (open: boolean) => void;
	} = $props();
</script>

{#if renaming}
	<!--
	Inline-edit affordance. We swap the anchor for
	an input bound to convUi.renameDraft; Enter commits,
	Esc cancels, blur-without-change cancels.
	Same padding/typography as the anchor so the
	row doesn't reflow when entering edit mode.
-->
	<input
		type="text"
		bind:this={convUi.renameInputEl}
		bind:value={convUi.renameDraft}
		onkeydown={convUi.onRenameKey}
		onblur={convUi.commitRename}
		maxlength={MAX_CONVERSATION_TITLE_LENGTH}
		aria-label="Rename conversation"
		class="block w-full rounded-md border border-border-strong bg-surface-panel py-2 pl-3 pr-3 text-sm focus:border-border-focus focus:outline-none"
	/>
{:else}
	<a
		{href}
		class="flex items-center gap-1.5 rounded-md py-2 pl-3 pr-8 text-sm transition active:bg-surface-sunken {active
			? 'bg-surface-sunken text-accent'
			: 'hover:bg-surface-sunken/70'}"
	>
		{#if activity === 'active'}
			<!-- A generation is running for this conversation right
			 now (see #lib/generating-conversations). Takes the
			 leading slot ahead of both the title spinner and the
			 private mask: on a first exchange all three compete,
			 and "a response is coming" is the one worth the pixel.
			 A pulsing dot rather than a ring so it doesn't read as
			 a second title spinner. -->
			<span
				class="h-2 w-2 shrink-0 animate-pulse rounded-full bg-accent motion-reduce:animate-none"
				role="img"
				aria-label="Generating a response"
				title="Generating…"
			></span>
		{:else if activity === 'queued'}
			<!-- In flight, but every branch is still behind the
			 endpoint's concurrency gate. Same slot and same size as
			 the dot above, so the rows stay aligned — but hollow and
			 still, because the whole point is that exactly one row
			 in a queued stack is the one doing work, and motion is
			 what the eye finds first when scanning a list.
			 A ring rather than a dimmer dot: opacity alone reads as
			 "the same thing, fainter", and doesn't survive a dark
			 room or a dimmed display, whereas filled-vs-empty
			 survives both and needs no animation to be legible
			 under prefers-reduced-motion. -->
			<span
				class="h-2 w-2 shrink-0 rounded-full border-[1.5px] border-accent/70"
				role="img"
				aria-label="Queued, waiting to generate"
				title="Queued…"
			></span>
		{:else if titlePending}
			<!-- Subtle spinner while the background auto-title
			 task is still generating this conversation's
			 title (see #lib/title-pending). -->
			<span
				class="h-3 w-3 shrink-0 animate-spin rounded-full border-2 border-border-focus border-t-transparent"
				aria-hidden="true"
				title="Generating title…"
			></span>
		{:else if c.private}
			<!-- Private (incognito) chat marker — a leading mask
			 glyph, mirroring the title-pending spinner's slot, so
			 sealed chats are recognizable at a glance in history. -->
			<VenetianMask
				size={14}
				strokeWidth={2.25}
				class="shrink-0 text-accent"
				aria-label="Private chat"
			/>
		{:else if c.scheduleId}
			<!-- A scheduled task's run: same leading slot, so a morning's
			 briefs read as briefs, not as chats someone started. -->
			<CalendarClock
				size={14}
				strokeWidth={2.25}
				class="shrink-0 text-fg-muted"
				aria-label="Scheduled task"
			/>
		{/if}
		<span class="min-w-0 truncate">{c.title ?? 'Untitled'}</span>
	</a>
	<DropdownMenu.Root open={menuOpen} onOpenChange={onMenuOpenChange}>
		<DropdownMenu.Trigger
			disabled={convUi.busyId === c.id}
			title="Conversation options"
			aria-label="Options for conversation {c.title ?? 'Untitled'}"
			class="absolute right-1 top-1/2 flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded border-0 bg-transparent text-fg-muted transition hover:bg-surface-sunken hover:text-fg-secondary focus-visible:opacity-100 disabled:opacity-50 can-hover:opacity-0 group-hover:opacity-100 data-[state=open]:opacity-100"
		>
			<MoreVertical size={14} strokeWidth={2.25} />
		</DropdownMenu.Trigger>
		<DropdownMenu.Portal>
			<DropdownMenu.Content
				sideOffset={4}
				align="end"
				class="z-overlay min-w-[160px] overflow-hidden rounded-md border border-border surface-glass gs-pop py-1 shadow-lg"
			>
				<DropdownMenu.Item
					onSelect={() => convUi.startRename(c.id, c.title)}
					class="flex cursor-pointer items-center gap-2 px-3 py-1.5 text-sm transition data-[highlighted]:bg-surface-raised"
				>
					<Pencil size={14} strokeWidth={2.25} />
					<span>Rename</span>
				</DropdownMenu.Item>
				<DropdownMenu.Item
					onSelect={() => convUi.archive(c.id)}
					class="flex cursor-pointer items-center gap-2 px-3 py-1.5 text-sm transition data-[highlighted]:bg-surface-raised"
				>
					<Archive size={14} strokeWidth={2.25} />
					<span>Archive</span>
				</DropdownMenu.Item>
				<DropdownMenu.Item
					onSelect={() => convUi.requestDelete(c.id)}
					class="flex cursor-pointer items-center gap-2 px-3 py-1.5 text-sm text-danger transition data-[highlighted]:bg-danger/10"
				>
					<Trash2 size={14} strokeWidth={2.25} />
					<span>Delete</span>
				</DropdownMenu.Item>
			</DropdownMenu.Content>
		</DropdownMenu.Portal>
	</DropdownMenu.Root>
{/if}
