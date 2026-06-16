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
import type { FanoutRecoveryState } from '$lib/types/api';

export type { FanoutRecoveryState };

export function getFanoutRecoveryState(
	conversationId: string,
	userId: string,
	activeLeafMessageId: string | null,
): FanoutRecoveryState {
	const parent = getFanoutParent(conversationId, userId);
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
	// Re-rolls are additive (a new sibling next to the original, deleting
	// nothing), so every persisted sibling is a real column — no shadowing.
	const siblings = getSiblingAssistants(conversationId, parent);
	return {
		parentMessageId: parent,
		kind: entries[0]?.modelKind ?? null,
		siblings,
		pending: entries.length,
		pendingModelIds: entries.map((e) => e.modelId ?? ''),
		pendingStartedAt: entries.map((e) => e.generationStartedAt),
	};
}
