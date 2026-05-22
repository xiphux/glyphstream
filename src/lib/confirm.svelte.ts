/**
 * App-wide destructive-action confirmation dialog.
 *
 * Singleton store mirroring `toast`: `confirmDialog.ask({...})` returns a
 * Promise<boolean> that resolves true when the user confirms and false
 * when they cancel. A single <ConfirmDialog> host (rendered once in the
 * app layout) renders the modal from this store's state.
 *
 * Replaces scattered window.confirm() calls — which can't be styled and
 * trip the browser's "don't let this site show more dialogs" suppression
 * after repeated use, the same reason DeleteConversationDialog exists for
 * the conversation-delete flow.
 */

export interface ConfirmRequest {
	/** Bold heading — the question, e.g. "Delete this branch?". */
	title: string;
	/** Body line below the title — the consequence of confirming. */
	message: string;
	/** Label for the destructive confirm button. Defaults to "Delete". */
	confirmLabel?: string;
}

interface PendingConfirm extends ConfirmRequest {
	resolve: (confirmed: boolean) => void;
}

class ConfirmDialogStore {
	pending = $state<PendingConfirm | null>(null);

	/** Open the dialog. Resolves true on confirm, false on cancel. */
	ask(request: ConfirmRequest): Promise<boolean> {
		// A dialog somehow already open is treated as cancelled so its
		// awaiter can't hang.
		this.pending?.resolve(false);
		return new Promise<boolean>((resolve) => {
			this.pending = { ...request, resolve };
		});
	}

	/** Called by the host component's Confirm button. */
	confirm(): void {
		this.pending?.resolve(true);
		this.pending = null;
	}

	/** Called by the host on Cancel / Escape / backdrop click. */
	cancel(): void {
		this.pending?.resolve(false);
		this.pending = null;
	}
}

export const confirmDialog = new ConfirmDialogStore();
