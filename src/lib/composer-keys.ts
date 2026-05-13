import type { EnterBehavior } from '$lib/types/api';

/**
 * Build a keydown handler for a message composer textarea that honors
 * the user's `enterBehavior` preference. Centralized so every composer
 * in the app (chat page, new-chat page, inline edit) gets identical
 * behavior — a divergence here would mean "Enter sends in one place and
 * not the other," which is exactly the kind of inconsistency
 * preferences are supposed to eliminate.
 *
 * Behavior:
 *   - 'send':    Enter → send, Shift+Enter → newline (default)
 *   - 'newline': Enter → newline, Cmd/Ctrl+Enter → send
 *
 * `e.isComposing` guard skips IME composition keystrokes — without it,
 * pressing Enter to confirm a Japanese/Chinese/Korean IME suggestion
 * would prematurely send the message.
 */
export function composerEnterHandler(
	behavior: EnterBehavior,
	onSend: (e: KeyboardEvent) => void
): (e: KeyboardEvent) => void {
	return (e: KeyboardEvent) => {
		if (e.key !== 'Enter' || e.isComposing) return;
		if (behavior === 'newline') {
			// Newline mode: only the modifier-Enter combo sends.
			if (e.metaKey || e.ctrlKey) {
				e.preventDefault();
				onSend(e);
			}
		} else {
			// Send mode: bare Enter sends, Shift+Enter is the newline escape.
			if (e.shiftKey) return;
			e.preventDefault();
			onSend(e);
		}
	};
}
