<!--
	Host for the app-wide confirm dialog. Rendered once in the (app)
	layout; it reads confirmDialog.pending and renders the modal. See
	$lib/confirm.svelte for the store and the confirmDialog.ask() API
	that callers use as a styled, promise-returning window.confirm().

	The shell — role=alertdialog, backdrop, Escape handling — lives in
	BaseDialog; this component supplies the title, message, and the
	Cancel + destructive-action buttons.
-->
<script lang="ts">
	import { confirmDialog } from '$lib/confirm.svelte';
	import BaseDialog from './BaseDialog.svelte';
</script>

{#if confirmDialog.pending}
	{@const p = confirmDialog.pending}
	<BaseDialog
		open={true}
		onCancel={() => confirmDialog.cancel()}
		titleId="confirm-dialog-title"
		title={p.title}
	>
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
				class="rounded-md btn-danger px-4 py-2 text-sm font-medium transition"
			>
				{p.confirmLabel ?? 'Delete'}
			</button>
		</div>
	</BaseDialog>
{/if}
