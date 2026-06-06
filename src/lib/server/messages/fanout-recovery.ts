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
import type { ChatMessage } from '$lib/types/api';

export interface FanoutRecoveryState {
	/** The shared user message the parked fan-out hangs off, or null when none. */
	parentMessageId: string | null;
	/** Persisted branch responses so far. */
	siblings: ChatMessage[];
	/** Branches still generating server-side. */
	pending: number;
}

export function getFanoutRecoveryState(
	conversationId: string,
	activeLeafMessageId: string | null,
): FanoutRecoveryState {
	const parent = getFanoutParent(conversationId);
	if (!parent || parent !== activeLeafMessageId) {
		return { parentMessageId: null, siblings: [], pending: 0 };
	}
	return {
		parentMessageId: parent,
		siblings: getSiblingAssistants(conversationId, parent),
		pending: getInFlightEntries(conversationId).length,
	};
}
