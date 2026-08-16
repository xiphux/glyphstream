<!--
	Shared shell for app-wide dialogs (ConfirmDialog,
	DeleteConversationDialog, DebugPanel). Owns the role + aria-modal,
	the backdrop, the Escape-key handler, and the panel chrome. Callers
	supply the title and body content (including action buttons) via
	props + a snippet.

	role defaults to alertdialog, which is right for a destructive-action
	confirmation — assistive tech then requires explicit user input before
	dismissal. A dialog that only PRESENTS something (DebugPanel) must pass
	role="dialog" instead: alertdialog on a panel with nothing to confirm
	interrupts a screen-reader user for no reason. Backdrop click and
	Escape both cancel either way.
-->
<script lang="ts">
	import type { Snippet } from 'svelte';

	let {
		open,
		onCancel,
		titleId,
		title,
		children,
		role = 'alertdialog',
	}: {
		/** Render the dialog when true; render nothing when false. */
		open: boolean;
		/** Called on Escape or backdrop click. */
		onCancel: () => void;
		/** Per-dialog id used by aria-labelledby on the dialog. */
		titleId: string;
		/** Plain-text title rendered as the <h2>. */
		title: string;
		/** Body content (description, optional form controls, action buttons). */
		children: Snippet;
		/** 'dialog' for panels that only present; see the comment above. */
		role?: 'alertdialog' | 'dialog';
	} = $props();

	function onWindowKey(e: KeyboardEvent): void {
		if (e.key === 'Escape' && open) onCancel();
	}
</script>

<svelte:window onkeydown={onWindowKey} />

{#if open}
	<!-- svelte-ignore a11y_click_events_have_key_events a11y_interactive_supports_focus -->
	<div
		{role}
		aria-modal="true"
		aria-labelledby={titleId}
		tabindex="-1"
		class="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm"
		onclick={(e) => {
			if (e.target === e.currentTarget) onCancel();
		}}
	>
		<div class="w-full max-w-md rounded-lg border border-border surface-glass gs-pop p-5 shadow-xl">
			<h2 id={titleId} class="text-base font-semibold">{title}</h2>
			{@render children()}
		</div>
	</div>
{/if}
