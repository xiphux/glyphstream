/**
 * Single aggregate notification for a multi-model fan-out.
 *
 * Each fan-out branch runs its own relay, and every relay would otherwise fire
 * its own `notifyConversationComplete` on `done` — so an N-branch fan-out would
 * buzz the user N times (the OS collapses them to one banner via the
 * conversation-id tag, but `renotify` re-alerts each, and in-app toasts don't
 * dedupe at all). Instead the initial fan-out branches suppress their per-branch
 * notification (the route passes `suppressNotify`) and this fires exactly one
 * "N ready" notification when the WHOLE fan-out has settled.
 *
 * "Whole fan-out settled" is detected via the in-flight registry: each branch's
 * relay clears its entry in `onComplete`, and the LAST branch to clear leaves
 * the conversation with no in-flight entries. The check runs synchronously right
 * after that clear (single-threaded Node — no interleaving), so exactly one
 * branch sees an empty registry and fires. No total-counting, so a branch that
 * errors before registering can't wedge the count.
 *
 * Regenerate (a lone re-roll) is deliberately NOT routed here — it keeps its own
 * single per-branch notification, the same as any one-shot generation.
 */

import { getSiblingAssistants } from '../db/queries/messages';
import { getInFlightEntries } from '../streaming/in-flight';
import { notifyConversationComplete, type NotifyModality } from '../push/notify';

export interface FanoutNotifyInput {
	conversationId: string;
	userId: string;
	/** The shared user message the branches hang off of — its assistant children
	 *  are the produced results. */
	userMessageId: string;
	conversationTitle: string | null;
	modality: NotifyModality;
	/** The fan-out's branch count (from the client), used as the displayed "N" in
	 *  the summary. Falls back to the produced-sibling count when absent. */
	fanoutSize?: number;
}

/** Fire-and-forget; never throws (delegates to notifyConversationComplete, which
 *  swallows its own errors). Call from a fan-out branch's `onComplete` AFTER
 *  clearInFlight — only the last branch (empty registry) actually notifies. */
export function notifyFanoutCompleteIfLast(input: FanoutNotifyInput): void {
	// Not the last branch — another is still generating; it will fire instead.
	if (getInFlightEntries(input.conversationId).length > 0) return;

	// Count what actually LANDED — successful results only. A failed branch now
	// persists a durable error sibling (see the `error` MessagePart) so a
	// disconnected fan-out can recover the failure; but it's not a result to
	// announce. Filtering error siblings restores the invariant the zero-guard
	// relies on: every branch failing → produced === 0 → stay silent (no false
	// "N ready" push), and a partial failure announces the honest count.
	const produced = getSiblingAssistants(input.conversationId, input.userMessageId).filter(
		(m) => !m.parts.some((p) => p.type === 'error'),
	).length;
	if (produced === 0) return;

	const count = input.fanoutSize ?? produced;
	void notifyConversationComplete({
		userId: input.userId,
		conversationId: input.conversationId,
		// The fan-out has no single "the" assistant message; reference the shared
		// user message so a click still resolves the conversation.
		assistantMessageId: input.userMessageId,
		conversationTitle: input.conversationTitle ?? 'New conversation',
		previewText: '',
		modality: input.modality,
		summary: `${count} ${resultNoun(input.modality, count)} ready`,
	});
}

/** Modality → human noun for the summary, pluralized by count. */
function resultNoun(modality: NotifyModality, count: number): string {
	const singular =
		modality === 'image'
			? 'image'
			: modality === 'video'
				? 'video'
				: modality === 'chat'
					? 'response'
					: 'result';
	return count === 1 ? singular : `${singular}s`;
}
