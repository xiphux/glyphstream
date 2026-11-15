/**
 * App-wide ephemeral toast notifications.
 *
 * Singleton store: `toast.success() / .info() / .error()` show a brief
 * confirmation message at the top of the viewport with optional
 * dismiss + action buttons. Used for action feedback (archive, with
 * Undo), error states, and the in-app notice when a thread completes
 * while the user is on a different page.
 *
 * Scope choices for v1 (intentional, revisit as pain emerges):
 *  - Single-slot: a new toast replaces the existing one. Users in
 *    practice don't fire rapid-enough actions for stacking to matter,
 *    and one-at-a-time keeps the visual surface predictable.
 *  - Swipe-up dismisses on touch (Toaster.svelte); the X covers mouse.
 *  - No bespoke enter/exit animation: animation across the rest of the
 *    UI is intentionally minimal; isolating motion to one component
 *    would look out of place. A future "animation polish pass" lifts
 *    this and everything else together (see ROADMAP).
 */

import { randomUUID } from '#lib/uuid.js';

type ToastKind = 'success' | 'info' | 'error';

export interface ToastAction {
	label: string;
	handler: () => void | Promise<void>;
}

export interface Toast {
	id: string;
	kind: ToastKind;
	message: string;
	/** Secondary line under the message. Optional; omit for a single-line toast. */
	description?: string;
	action?: ToastAction;
}

interface ShowOptions {
	action?: ToastAction;
	/** Secondary line under the message — a completion's body line, say. Must
	 *  stay declared: callers spread their options in, and excess-property
	 *  checking does not apply to spread properties, so an undeclared field is
	 *  silently dropped with no type error. */
	description?: string;
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
			id: randomUUID(),
			kind,
			message,
			description: options.description,
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
