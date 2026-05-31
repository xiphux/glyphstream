/**
 * App-wide ephemeral toast notifications.
 *
 * Singleton store: `toast.success() / .info() / .error()` show a brief
 * confirmation message at the bottom of the viewport with optional
 * dismiss + action buttons. Used today for archive feedback (with
 * Undo) and surfacing error states; designed to absorb the roadmap's
 * background-generation-complete notifications next.
 *
 * Scope choices for v1 (intentional, revisit as pain emerges):
 *  - Single-slot: a new toast replaces the existing one. Users in
 *    practice don't fire rapid-enough actions for stacking to matter,
 *    and one-at-a-time keeps the visual surface predictable.
 *  - No swipe-to-dismiss: defaults keep toasts short-lived enough that
 *    they inform without overstaying. The explicit X button covers the
 *    "I want it gone right now" case.
 *  - No bespoke enter/exit animation: animation across the rest of the
 *    UI is intentionally minimal; isolating motion to one component
 *    would look out of place. A future "animation polish pass" lifts
 *    this and everything else together (see ROADMAP).
 */

type ToastKind = 'success' | 'info' | 'error';

export interface ToastAction {
	label: string;
	handler: () => void | Promise<void>;
}

export interface Toast {
	id: string;
	kind: ToastKind;
	message: string;
	action?: ToastAction;
}

interface ShowOptions {
	action?: ToastAction;
	/** Override auto-dismiss timeout in ms. Pass 0 to keep the toast
	 *  visible until explicit dismiss/replacement. */
	duration?: number;
}

// Errors get longer by default — they often require the user to read
// a sentence or two, where success/info confirmations are skim-glance.
const DEFAULT_DURATION: Record<ToastKind, number> = {
	success: 4000,
	info: 4000,
	error: 6000,
};

class ToastStore {
	current = $state<Toast | null>(null);
	private timer: ReturnType<typeof setTimeout> | null = null;

	private show(kind: ToastKind, message: string, options: ShowOptions): void {
		if (this.timer) {
			clearTimeout(this.timer);
			this.timer = null;
		}
		this.current = {
			id: crypto.randomUUID(),
			kind,
			message,
			action: options.action,
		};
		const duration = options.duration ?? DEFAULT_DURATION[kind];
		if (duration > 0) {
			this.timer = setTimeout(() => {
				this.current = null;
				this.timer = null;
			}, duration);
		}
	}

	success(message: string, options: ShowOptions = {}): void {
		this.show('success', message, options);
	}

	info(message: string, options: ShowOptions = {}): void {
		this.show('info', message, options);
	}

	error(message: string, options: ShowOptions = {}): void {
		this.show('error', message, options);
	}

	dismiss(): void {
		if (this.timer) {
			clearTimeout(this.timer);
			this.timer = null;
		}
		this.current = null;
	}
}

export const toast = new ToastStore();
