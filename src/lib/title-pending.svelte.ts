/**
 * Client-side reactive set of conversation ids whose auto-generated
 * title is still pending.
 *
 * The auto-title task runs server-side once the first exchange's
 * response completes. The chat page flags the conversation from the
 * moment its first message is submitted until the title task has run
 * (the SSE stream closes) — deliberately a touch wider than the task's
 * own runtime, so the sidebar's title slot reads as "a title is
 * coming" for the whole first turn instead of blinking in late. The
 * sidebar shows a subtle spinner next to the title while the flag is
 * set. Purely client-side — the chat page observes the timing
 * first-hand, so no server round-trip is needed.
 */

import { SvelteSet } from 'svelte/reactivity';

const pending = new SvelteSet<string>();

/** Flag a conversation as having its title generated right now. */
export function markTitlePending(conversationId: string): void {
	pending.add(conversationId);
}

/** Clear the flag. Idempotent — safe to call for an unflagged id. */
export function clearTitlePending(conversationId: string): void {
	pending.delete(conversationId);
}

/** Reactive: true while the conversation's title is being generated. */
export function isTitlePending(conversationId: string): boolean {
	return pending.has(conversationId);
}
