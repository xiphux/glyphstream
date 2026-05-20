/**
 * Pure decision function: given the set of open browser windows
 * (clients) and an incoming push payload, decide what the service
 * worker should do with it. Extracted into a leaf module so it can be
 * unit-tested without spinning up a real SW.
 *
 * Three outcomes:
 *  - 'silent': the user is already looking at the relevant thread. The
 *    SSE stream is delivering this message in real time, so any
 *    additional notification would be redundant.
 *  - 'toast': the user has the app open but is on a different page.
 *    The SW posts a message to visible clients; the client renders an
 *    in-app toast with a click-to-navigate action.
 *  - 'os': no visible client — app backgrounded, tab closed, phone
 *    locked. The SW raises an OS-level notification.
 *
 * The same-thread suppression happens even when foregroundToast is
 * false. The two settings are independent: "don't toast me about
 * other threads" doesn't imply "spam me on the thread I'm watching."
 */

export interface ArbiterClient {
	url: string;
	visibilityState: 'visible' | 'hidden' | 'prerender';
}

export interface ArbiterPayload {
	conversationId: string;
	foregroundToast: boolean;
}

export type ArbiterAction = 'silent' | 'toast' | 'os';

/**
 * Decide what the SW should do with an incoming push. Returns the
 * coarse action; the SW caller is responsible for actually executing
 * it (postMessage to clients vs. showNotification).
 */
export function pickAction(clients: ArbiterClient[], payload: ArbiterPayload): ArbiterAction {
	const sameThreadVisible = clients.some(
		(c) => c.visibilityState === 'visible' && isOnConversation(c.url, payload.conversationId)
	);
	if (sameThreadVisible) return 'silent';

	const anyVisible = clients.some((c) => c.visibilityState === 'visible');
	if (anyVisible && payload.foregroundToast) return 'toast';

	return 'os';
}

/**
 * URL matching needs to tolerate query strings (?something), hash
 * fragments (#section), and trailing slashes — none of those change
 * which conversation the user is looking at. Pulled into its own
 * helper so the test suite can verify the matching rules
 * independently from the action policy.
 */
export function isOnConversation(clientUrl: string, conversationId: string): boolean {
	try {
		const path = new URL(clientUrl).pathname.replace(/\/+$/, '');
		return path === `/chat/${conversationId}`;
	} catch {
		return false;
	}
}
