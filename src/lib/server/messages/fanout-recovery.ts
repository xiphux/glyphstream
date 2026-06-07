/**
 * Server-truth state for recovering a parked multi-model fan-out after the
 * client disconnects (iOS suspending the PWA, a dropped connection, or a full
 * reload). The branches keep generating + persisting server-side regardless of
 * the client, so on return the page rebuilds the compare grid from here rather
 * than from the (now-broken) client fetches:
 *
 *   - `siblings`  — the branches that have already persisted (done columns).
 *   - `pending`   — how many are still generating (placeholder columns), read
 *                   from the in-flight registry.
 *
 * Surfaced both by the page load (full reload) and the lightweight GET endpoint
 * (the recovery poll that updates the grid as branches land). Empty unless the
 * fan-out marker points at the current active leaf — i.e. an unresolved
 * fan-out is genuinely parked here.
 */

import { getFanoutParent } from '../db/queries/conversations';
import { getSiblingAssistants } from '../db/queries/messages';
import { getInFlightEntries } from '../streaming/in-flight';
import type { ChatMessage, ModelKind } from '$lib/types/api';

export interface FanoutRecoveryState {
	/** The shared user message the parked fan-out hangs off, or null when none. */
	parentMessageId: string | null;
	/** The fan-out's modality, from the still-generating branches — lets the
	 *  client render the right (media vs chat) grid even when no branch has
	 *  persisted yet (the all-pending window, long for video). Null when none
	 *  are in flight (the client then infers from the persisted siblings). */
	kind: ModelKind | null;
	/** Persisted branch responses so far. */
	siblings: ChatMessage[];
	/** In-flight registry entries for this conversation — branches still
	 *  generating. May transiently over-count by one: a branch persists its
	 *  row (so it's also in `siblings`) a beat before the relay/handler finally
	 *  clears its registry slot, so a poll landing in that window briefly sees
	 *  it in both. Self-corrects on the next tick; the client renders a
	 *  short-lived extra "Generating…" placeholder, never a lost result. */
	pending: number;
	/** The model id of each still-generating branch (aligned with `pending`;
	 *  empty string when an entry didn't record one). Lets the recovered grid
	 *  label each "generating" placeholder with its model, like the live grid,
	 *  instead of a bare "Generating…". */
	pendingModelIds: string[];
	/** When each pending branch began generating (acquired its slot), aligned
	 *  with `pendingModelIds`, or null while still QUEUED behind the gate. Lets
	 *  the recovered grid restore the per-branch QUEUED badge vs. elapsed timer
	 *  — the full live state, important for a long iOS-suspended fan-out. */
	pendingStartedAt: (number | null)[];
}

export function getFanoutRecoveryState(
	conversationId: string,
	activeLeafMessageId: string | null,
): FanoutRecoveryState {
	const parent = getFanoutParent(conversationId);
	if (!parent || parent !== activeLeafMessageId) {
		return {
			parentMessageId: null,
			kind: null,
			siblings: [],
			pending: 0,
			pendingModelIds: [],
			pendingStartedAt: [],
		};
	}
	const entries = getInFlightEntries(conversationId);
	return {
		parentMessageId: parent,
		kind: entries[0]?.modelKind ?? null,
		siblings: getSiblingAssistants(conversationId, parent),
		pending: entries.length,
		pendingModelIds: entries.map((e) => e.modelId ?? ''),
		pendingStartedAt: entries.map((e) => e.generationStartedAt),
	};
}
