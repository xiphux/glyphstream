/**
 * Pure decision function: given each open window's self-reported state
 * (which conversation it's showing + whether it's visible) and an
 * incoming push payload, decide what the service worker should do.
 *
 * Three outcomes:
 *  - 'silent': a visible window is already on the relevant thread. The
 *    SSE stream there is delivering this message in real time, so any
 *    extra notification would be redundant.
 *  - 'toast': the app is open and visible somewhere, but not on this
 *    thread. The SW posts a message to the visible clients; they render
 *    an in-app toast with a click-to-navigate action.
 *  - 'os': no visible client — app backgrounded, tab closed, phone
 *    locked. The SW raises an OS-level notification.
 *
 * Inputs are the windows' own reports rather than WindowClient.url +
 * visibilityState read from the SW side. WindowClient.url does not
 * reliably reflect SvelteKit's client-side (pushState) navigation, so a
 * window that SPA-navigated to /chat/{id} can still report its original
 * load URL — which would make the SW notify the user about the very
 * thread they're watching. Instead the SW asks each window what route
 * it's actually on; see ActiveConversationReport in $lib/types/push.
 *
 * Same-thread suppression happens even when foregroundToast is false:
 * "don't toast me about other threads" doesn't imply "spam me on the
 * thread I'm watching."
 */

import type { ActiveConversationReport } from '$lib/types/push';

export interface ArbiterPayload {
	conversationId: string;
	foregroundToast: boolean;
}

export type ArbiterAction = 'silent' | 'toast' | 'os';

/**
 * Decide what the SW should do with an incoming push. `reports` holds
 * one entry per window that answered the SW's query; windows that
 * didn't answer (suspended, closed) are simply absent — they can't be
 * "actively viewing" anything, so their absence correctly pushes the
 * decision toward an OS notification.
 *
 * The SW caller is responsible for executing the action (postMessage to
 * the visible clients vs. showNotification).
 */
export function pickAction(
	reports: ActiveConversationReport[],
	payload: ArbiterPayload,
): ArbiterAction {
	const sameThreadVisible = reports.some(
		(r) => r.visible && r.conversationId === payload.conversationId,
	);
	if (sameThreadVisible) return 'silent';

	const anyVisible = reports.some((r) => r.visible);
	if (anyVisible && payload.foregroundToast) return 'toast';

	return 'os';
}
