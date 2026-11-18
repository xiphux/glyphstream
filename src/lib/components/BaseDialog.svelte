<!--
	Shared shell for app-wide dialogs (ConfirmDialog,
	DeleteConversationDialog, DebugPanel, AvatarDrawDialog). Owns the role + aria-modal,
	the backdrop, the Escape-key handler, and the panel chrome. Callers
	supply the title and body content (including action buttons) via
	props + a snippet.

	role defaults to alertdialog, which is right for a destructive-action
	confirmation — assistive tech then requires explicit user input before
	dismissal. Any other dialog (DebugPanel, AvatarDrawDialog) must pass
	role="dialog" instead: alertdialog there interrupts a screen-reader user
	for no reason. Backdrop click and
	Escape both cancel either way.

	aria-modal tells assistive tech the page behind is inert, so focus is
	held to match: it moves in on open, Tab cycles inside, and it goes back
	to whatever had it on close. See `holdFocus`.
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
		wide = false,
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
		/** Room for a grid rather than a form (a photo comparison). */
		wide?: boolean;
	} = $props();

	const FOCUSABLE =
		'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

	/**
	 * Take focus on open and return it on close; keep Tab inside meanwhile.
	 *
	 * An alertdialog opens on its first button (Cancel, by the consumers'
	 * order), so a stray Enter can't confirm. A dialog opens on its first
	 * control — unless that is a text field, which would raise the iOS
	 * keyboard over the dialog before the user chose to type (the avatar
	 * prompt); the dialog itself takes focus then, one Tab short of the field.
	 */
	function holdFocus(node: HTMLElement) {
		const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
		const focusables = () => [...node.querySelectorAll<HTMLElement>(FOCUSABLE)];
		const first =
			role === 'alertdialog'
				? node.querySelector<HTMLElement>('button:not([disabled])')
				: focusables()[0];
		const typesText =
			first instanceof HTMLTextAreaElement ||
			(first instanceof HTMLInputElement &&
				!['checkbox', 'radio', 'button', 'submit'].includes(first.type));
		(first && !typesText ? first : node).focus();

		function onKey(e: KeyboardEvent) {
			if (e.key !== 'Tab') return;
			const list = focusables();
			const active = document.activeElement;
			if (list.length === 0) {
				e.preventDefault();
			} else if (e.shiftKey && (active === list[0] || active === node)) {
				e.preventDefault();
				list[list.length - 1].focus();
			} else if (!e.shiftKey && active === list[list.length - 1]) {
				e.preventDefault();
				list[0].focus();
			}
		}
		node.addEventListener('keydown', onKey);
		return () => {
			node.removeEventListener('keydown', onKey);
			if (previous?.isConnected) previous.focus();
		};
	}

	// Bubble phase on window, so a popover inside the dialog (a model picker)
	// that consumes Escape gets it first; preventDefault then tells any layer
	// underneath (the media lightbox) that this Escape is spent.
	function onWindowKey(e: KeyboardEvent): void {
		if (e.key === 'Escape' && open && !e.defaultPrevented) {
			e.preventDefault();
			onCancel();
		}
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
		{@attach holdFocus}
		class="fixed inset-0 z-overlay flex items-center justify-center bg-black/60 p-4 outline-none backdrop-blur-sm"
		onclick={(e) => {
			if (e.target === e.currentTarget) onCancel();
		}}
	>
		<div
			class={[
				'w-full rounded-lg border border-border surface-glass gs-pop p-5 shadow-xl',
				wide ? 'max-w-2xl' : 'max-w-md',
			]}
		>
			<h2 id={titleId} class="text-base font-semibold">{title}</h2>
			{@render children()}
		</div>
	</div>
{/if}
