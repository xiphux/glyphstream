<!--
	Host for the app-wide confirm dialog. Rendered once in the (app)
	layout; it reads confirmDialog.pending and renders the modal. See
	$lib/confirm.svelte for the store and the confirmDialog.ask() API
	that callers use as a styled, promise-returning window.confirm().

	role=alertdialog because the action is destructive — assistive tech
	then requires explicit user input before dismissal. Backdrop click
	and Escape both cancel.
-->
<script lang="ts">
	import { confirmDialog } from '$lib/confirm.svelte';

	function onWindowKey(e: KeyboardEvent) {
		if (e.key === 'Escape' && confirmDialog.pending) confirmDialog.cancel();
	}
</script>

<svelte:window onkeydown={onWindowKey} />

{#if confirmDialog.pending}
	{@const p = confirmDialog.pending}
	<!-- svelte-ignore a11y_click_events_have_key_events a11y_interactive_supports_focus -->
	<div
		role="alertdialog"
		aria-modal="true"
		aria-labelledby="confirm-dialog-title"
		tabindex="-1"
		class="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm"
		onclick={(e) => {
			if (e.target === e.currentTarget) confirmDialog.cancel();
		}}
	>
		<div
			class="w-full max-w-md rounded-lg border border-border surface-glass gs-pop p-5 shadow-xl"
		>
			<h2 id="confirm-dialog-title" class="text-base font-semibold">{p.title}</h2>
			<p class="mt-2 text-sm text-fg-muted">{p.message}</p>
			<div class="mt-5 flex items-center justify-end gap-2">
				<button
					type="button"
					onclick={() => confirmDialog.cancel()}
					class="rounded-md border border-border-strong bg-surface-panel px-4 py-2 text-sm transition hover:bg-surface-raised"
				>
					Cancel
				</button>
				<button
					type="button"
					onclick={() => confirmDialog.confirm()}
					class="rounded-md bg-red-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-red-700"
				>
					{p.confirmLabel ?? 'Delete'}
				</button>
			</div>
		</div>
	</div>
{/if}
