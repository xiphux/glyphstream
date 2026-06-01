<!--
	Shared shell for app-wide destructive-action dialogs (ConfirmDialog,
	DeleteConversationDialog). Owns the alertdialog role + aria-modal,
	the backdrop, the Escape-key handler, and the panel chrome. Callers
	supply the title and body content (including action buttons) via
	props + a snippet.

	role=alertdialog (not dialog) because every caller is a destructive-
	action confirmation — assistive tech then requires explicit user
	input before dismissal. Backdrop click and Escape both cancel.
-->
<script lang="ts">
	import type { Snippet } from 'svelte';

	let {
		open,
		onCancel,
		titleId,
		title,
		children,
	}: {
		/** Render the dialog when true; render nothing when false. */
		open: boolean;
		/** Called on Escape or backdrop click. */
		onCancel: () => void;
		/** Per-dialog id used by aria-labelledby on the alertdialog. */
		titleId: string;
		/** Plain-text title rendered as the <h2>. */
		title: string;
		/** Body content (description, optional form controls, action buttons). */
		children: Snippet;
	} = $props();

	function onWindowKey(e: KeyboardEvent): void {
		if (e.key === 'Escape' && open) onCancel();
	}
</script>

<svelte:window onkeydown={onWindowKey} />

{#if open}
	<!-- svelte-ignore a11y_click_events_have_key_events a11y_interactive_supports_focus -->
	<div
		role="alertdialog"
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
