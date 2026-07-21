/**
 * Per-tool-call approval-flow primitives shared by the chat page and the
 * approval-prompt components. Lives separately from the chat page so the
 * resume-fetch contract and the decision-snapshot math are unit-testable
 * without spinning up a chat.
 *
 * ChatTurnController owns the surrounding state machine (the
 * approvalSubmitting latch, the in-flight resume stream, post-resume
 * invalidateAll); the chat page only forwards decisions via
 * turn.submitApproval(...) and reads turn.approvalSubmitting for UI guards.
 * What lives here is the type that previously duplicated across five
 * component files, the pure decision-snapshot builder (default-to-reject is
 * a subtle rule), and the fetch wrapper that owns the URL, body shape, and
 * error extraction.
 */

import { errorMessageFromResponse } from './fetch-error';

export type ApprovalAction = 'allow' | 'allow_always' | 'reject';

export interface ApprovalDecision {
	toolCallId: string;
	action: ApprovalAction;
}

/**
 * Build the decision payload from a set of pending tool-call ids and
 * a map of user-selected actions. A pending id with no recorded
 * decision defaults to 'reject' — the safe choice (refuses the tool),
 * matching the implicit semantics if the user closed the page without
 * picking. Order follows the iteration order of `ids`.
 */
export function buildApprovalDecisionsSnapshot(
	ids: Iterable<string>,
	decisions: ReadonlyMap<string, ApprovalAction>,
): ApprovalDecision[] {
	return Array.from(ids, (id) => ({
		toolCallId: id,
		action: decisions.get(id) ?? 'reject',
	}));
}

/**
 * POST the user's approval decisions to the resume endpoint and hand
 * the SSE body off to `consumeStream` for the caller-specific
 * in-flight bubble rendering. The fetch URL, content-type, body shape,
 * and error-message extraction live here so they aren't duplicated.
 * The caller still owns the AbortController so cancel wiring (Stop
 * button, conversation switch) flows through it.
 *
 * Throws on a !res.ok response (with a friendly server message via
 * errorMessageFromResponse) or a missing body. AbortError from `signal`
 * propagates as-is — the caller's catch decides whether to surface it.
 */
export async function runApprovalResume<T>(
	convId: string,
	decisions: ApprovalDecision[],
	signal: AbortSignal,
	consumeStream: (body: ReadableStream<Uint8Array>) => Promise<T>,
): Promise<T> {
	const res = await fetch(`/api/conversations/${convId}/tool-approval`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
		body: JSON.stringify({ decisions }),
		signal,
	});
	if (!res.ok) throw new Error(await errorMessageFromResponse(res));
	if (!res.body) throw new Error('Server returned no body');
	return consumeStream(res.body);
}
