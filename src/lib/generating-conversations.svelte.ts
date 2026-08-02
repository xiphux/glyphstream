/**
 * Client-side reactive set of conversation ids that have a generation
 * running right now — the sidebar's "still cooking" dot.
 *
 * The point of this is the conversation you're NOT looking at. A send
 * survives navigating away (the chat page's teardown aborts only the local
 * fetch; the server keeps generating and fires its push when done — see
 * chat-turn-controller's `teardown`), so without a sidebar mark the thread
 * you left goes visually inert and the only "it finished" signal is the OS
 * notification.
 *
 * Lifecycle, and why it takes three inputs:
 *
 *  - **Marked** by the chat page from its `renderingGeneration` signal, the
 *    same source `stream-presence` publishes from. Deliberately NOT cleared
 *    on unmount (unlike stream presence, which must go quiet the moment a tab
 *    stops rendering): surviving the navigation away is the entire feature.
 *  - **Seeded** once at `(app)` layout mount from the server's in-flight
 *    registry, so a reload / cold PWA launch into some *other* thread still
 *    shows the video you left cooking. Because that registry is keyed by
 *    conversation, not by device, this is also the one path that surfaces a
 *    generation started on another device. Seeded once rather than on every
 *    `data` refresh because mid-session the local marks below are immediate
 *    and authoritative, so re-reading server state can only lag them.
 *  - **Reconciled** by the layout's poll while the set is non-empty, which is
 *    the only way an id marked before a navigation ever comes back off:
 *    nothing local is listening to that generation any more. Clear-only — it
 *    never *adds*, so a generation started elsewhere after this page loaded
 *    stays invisible until the next load; a client learning about one live is
 *    the standing per-user channel that ROADMAP's live cross-client sync
 *    defers.
 *
 * Module singleton, mirroring `title-pending` / `stream-presence` — the
 * layout is the chat page's parent, so a module-level store is the only way
 * to read page-published state. Mutated exclusively from browser contexts
 * ($effect / onMount), so the SSR copy of this module — shared across every
 * user's request — stays permanently empty and can't leak one user's
 * activity into another's render.
 */

import { SvelteSet } from 'svelte/reactivity';

const generating = new SvelteSet<string>();

/** Flag a conversation as having a generation in flight. */
export function markGenerating(conversationId: string): void {
	generating.add(conversationId);
}

/** Clear the flag. Idempotent — safe to call for an unflagged id. */
export function clearGenerating(conversationId: string): void {
	generating.delete(conversationId);
}

/** Reactive: true while the conversation has a generation in flight. */
export function isGenerating(conversationId: string): boolean {
	return generating.has(conversationId);
}

/** Reactive: true while anything is flagged — the layout's poll gate. */
export function anyGenerating(): boolean {
	return generating.size > 0;
}

/**
 * Drop every flagged id the server no longer reports as in flight. Clear-only
 * by design (see the module comment): `activeIds` is the authority on what has
 * *finished*, never on what has started.
 */
export function reconcileGenerating(activeIds: readonly string[]): void {
	// A malformed answer is NO information, not "everything finished". Without
	// this, `new Set(undefined)` — which the spec makes an empty set rather than
	// a throw — would clear every flag at once, and since the layout's poll is
	// gated on the set being non-empty it would then stop, leaving genuinely
	// running generations unmarked until a reload. The rest of the codebase can
	// cast a response body and let a bad shape throw into a retry; here the
	// nonsense value is silently *valid*, so it has to be rejected explicitly.
	if (!Array.isArray(activeIds)) return;
	const active = new Set(activeIds);
	for (const id of generating) {
		if (!active.has(id)) generating.delete(id);
	}
}

/** Test-only. */
export function resetGenerating(): void {
	generating.clear();
}
