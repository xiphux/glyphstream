/**
 * Client-side reactive record of which conversations have a generation running
 * right now, and whether any of it has actually STARTED — the sidebar's "still
 * cooking" mark.
 *
 * The point of this is the conversation you're NOT looking at. A send
 * survives navigating away (the chat page's teardown aborts only the local
 * fetch; the server keeps generating and fires its push when done — see
 * chat-turn-controller's `teardown`), so without a sidebar mark the thread
 * you left goes visually inert and the only "it finished" signal is the OS
 * notification.
 *
 * Two sets rather than one map, and the split is load-bearing:
 *
 *  - `generating` is MEMBERSHIP — "this conversation has work in flight". It
 *    is what the chat page's self-heal subscribes to (see below), and its
 *    lifecycle is described in full further down.
 *  - `queued` is ACTIVITY — the subset whose every in-flight branch is still
 *    waiting on the endpoint's concurrency gate, so nothing is generating yet.
 *
 * A `SvelteMap<id, activity>` would fuse the two, and that fusion deadlocks:
 * the chat page's effect writes activity AND reads membership to self-heal, so
 * a map whose per-key signal covers both would re-run that effect on every
 * activity write — including the poll's, whose value the page would then
 * overwrite, which is another activity write. Separate sets make the read
 * (`isGenerating`) genuinely independent of the activity writes, so server
 * truth and local truth can disagree for a tick instead of ping-ponging.
 *
 * Which matters because the two are authoritative about different things. The
 * page knows its own fan-out's per-branch state instantly; the poll is the
 * only thing that ever learns a QUEUED conversation has reached the front of
 * the line, because nothing local is listening to a generation the user
 * walked away from. On the one conversation where both speak, the poll wins by
 * arriving second — which is right: where they disagree, the page is guessing
 * (a recovered single turn reports 'active' because the recovery payload
 * carries no gate state) and the server is not.
 *
 * Lifecycle of MEMBERSHIP, and why it takes three inputs:
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
 *    defers. ACTIVITY, by contrast, is overwritten on any reconcile that
 *    carries it: it's a property of an id already known to be running, not a
 *    new id. A reconcile that says nothing about activity leaves it alone —
 *    which is a different thing from saying nothing is queued; see below.
 *
 * Module singleton, mirroring `title-pending` / `stream-presence` — the
 * layout is the chat page's parent, so a module-level store is the only way
 * to read page-published state. Mutated exclusively from browser contexts
 * ($effect / onMount), so the SSR copy of this module — shared across every
 * user's request — stays permanently empty and can't leak one user's
 * activity into another's render.
 */

import { SvelteSet } from 'svelte/reactivity';

/**
 * What a marked conversation is doing: `'active'` means at least one of its
 * generations holds an endpoint slot and is producing output; `'queued'` means
 * every one of them is still behind the gate, waiting its turn.
 *
 * The distinction only becomes visible with several multi-model conversations
 * in flight against a one-at-a-time endpoint — a single GPU that can hold one
 * model at a time — where without it every waiting thread wears the same
 * "working on it" mark as the one thread that actually is.
 */
export type GenerationActivity = 'active' | 'queued';

const generating = new SvelteSet<string>();
const queued = new SvelteSet<string>();

/**
 * Flag a conversation as having a generation in flight, and say whether any of
 * it has started. Defaults to `'active'` for callers that can't tell — the
 * pre-gate-aware meaning, and the safer default: over-reporting activity costs
 * a wrong icon, under-reporting hides the one thread the user is looking for.
 */
export function markGenerating(
	conversationId: string,
	activity: GenerationActivity = 'active',
): void {
	generating.add(conversationId);
	if (activity === 'queued') queued.add(conversationId);
	else queued.delete(conversationId);
}

/** Clear the flag. Idempotent — safe to call for an unflagged id. */
export function clearGenerating(conversationId: string): void {
	generating.delete(conversationId);
	queued.delete(conversationId);
}

/**
 * Reactive: true while the conversation has a generation in flight, whether
 * it's generating or still queued.
 *
 * Deliberately reads only the membership set — see the module comment: the
 * chat page's mark effect calls this to subscribe to its own id's membership,
 * and folding activity into the same signal would make every activity write
 * re-run that effect.
 */
export function isGenerating(conversationId: string): boolean {
	return generating.has(conversationId);
}

/**
 * Reactive: what the conversation is doing, or null when nothing is in flight.
 * The sidebar's single read — it needs all three states, and asking once keeps
 * "queued but not running" from being expressible as anything else.
 */
export function generationActivity(conversationId: string): GenerationActivity | null {
	if (!generating.has(conversationId)) return null;
	return queued.has(conversationId) ? 'queued' : 'active';
}

/** Reactive: true while anything is flagged — the layout's poll gate. */
export function anyGenerating(): boolean {
	return generating.size > 0;
}

/**
 * Drop every flagged id the server no longer reports as in flight, and refresh
 * the activity of the ones that survive.
 *
 * Clear-only on MEMBERSHIP by design (see the module comment): `activeIds` is
 * the authority on what has *finished*, never on what has started. Activity is
 * a different matter — `queuedIds` fully replaces what we believed about the
 * surviving ids, because a queued conversation reaching the front of the line
 * is a transition no client can observe any other way.
 */
export function reconcileGenerating(
	activeIds: readonly string[],
	// No default. `= []` would read a missing answer as "nothing is queued" and
	// repaint every waiting thread as running — and it's exactly the explicit
	// `undefined` a caller passes when the server didn't send the field.
	queuedIds?: readonly string[],
): void {
	// A malformed answer is NO information, not "everything finished". Without
	// this, `new Set(undefined)` — which the spec makes an empty set rather than
	// a throw — would clear every flag at once, and since the layout's poll is
	// gated on the set being non-empty it would then stop, leaving genuinely
	// running generations unmarked until a reload. The rest of the codebase can
	// cast a response body and let a bad shape throw into a retry; here the
	// nonsense value is silently *valid*, so it has to be rejected explicitly.
	if (!Array.isArray(activeIds)) return;
	// The same trap, one notch quieter: a missing/garbled `queuedIds` would read
	// as "nothing is queued" and repaint every waiting thread as active. Treat it
	// as no information about activity too, and leave what we already believed —
	// which for a server that predates the field is exactly right, since it had
	// no gate state to report. Membership still reconciles: it's the half we
	// were told about.
	const activityKnown = Array.isArray(queuedIds);
	const active = new Set(activeIds);
	const nowQueued = activityKnown ? new Set(queuedIds) : null;
	for (const id of generating) {
		if (!active.has(id)) {
			generating.delete(id);
			queued.delete(id);
		} else if (nowQueued) {
			if (nowQueued.has(id)) queued.add(id);
			else queued.delete(id);
		}
	}
}

/** Test-only. */
export function resetGenerating(): void {
	generating.clear();
	queued.clear();
}
