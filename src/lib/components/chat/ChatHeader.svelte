<!--
	Chat page header: the conversation title on one row, plus a "Private" badge on
	the right for a private (incognito) chat. The model name lives in each assistant
	bubble and in the composer's model picker, so it isn't repeated here — and a
	single header model name would be misleading in a multi-model thread anyway. The
	context-budget readout + Compact action are in `ContextBudgetBar`, above the
	composer.
-->
<script lang="ts">
	import { Sparkles, VenetianMask } from '@lucide/svelte';

	interface Props {
		title: string | null;
		/** Private (incognito) chat — shows the badge; the whole app also re-tints. */
		private?: boolean;
		/**
		 * Starts avatar generation. Omitted — and the control hidden — where it
		 * can't work: an image or video conversation has no model that can reply
		 * with a description. The page decides; this component stays
		 * presentational, same as the lightbox's optional actions.
		 */
		onGenerateAvatar?: () => void;
	}

	let { title, private: isPrivate = false, onGenerateAvatar }: Props = $props();
</script>

<header class="flex items-center gap-3 px-4 py-3">
	<h1 class="min-w-0 flex-1 truncate text-sm font-semibold">{title ?? 'Untitled chat'}</h1>
	{#if onGenerateAvatar}
		<button
			type="button"
			onclick={onGenerateAvatar}
			aria-label="Generate an avatar for this conversation"
			title="Generate an avatar — starts by asking the model to describe one"
			class="flex size-8 shrink-0 items-center justify-center rounded-md text-fg-muted transition hover:bg-surface-sunken hover:text-fg-secondary"
		>
			<Sparkles size={15} strokeWidth={2.25} />
		</button>
	{/if}
	{#if isPrivate}
		<!-- Desktop only: on mobile the badge moves to the layout's top bar so the
		     tiny-screen title gets the full row width (see the layout). -->
		<span
			class="hidden shrink-0 items-center gap-1.5 rounded-full bg-accent/12 px-2.5 py-1 text-xs font-medium text-accent sm:flex"
			title="Private chat — nothing from this chat is saved to memories, summaries, or search, and personalization / web / MCP tools are off"
		>
			<VenetianMask size={13} strokeWidth={2.25} />
			<span>Private</span>
		</span>
	{/if}
</header>
