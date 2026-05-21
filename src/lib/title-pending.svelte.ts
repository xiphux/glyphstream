/**
 * Client-side reactive set of conversation ids whose auto-generated
 * title is still being produced by the background task model.
 *
 * The auto-title task runs server-side after the first exchange's
 * response completes; the SSE stream is held open until the title
 * lands (or the delivery budget expires). The chat page marks a
 * conversation for exactly that window; the sidebar reads it to show a
 * subtle spinner next to the title. Purely client-side — the chat page
 * observes the timing first-hand, so no server round-trip is needed.
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
