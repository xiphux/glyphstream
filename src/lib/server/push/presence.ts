/**
 * Ephemeral cross-device viewer presence for notification suppression.
 *
 * The push pipeline fires on every completion and the service worker
 * arbitrates locally — but a device's SW can only see its OWN windows, so it
 * can't tell you're watching the same thread on another device. That's the
 * gap that makes the phone buzz while you watch a response finish on the
 * desktop. This registry closes it: while a chat window is visible it
 * heartbeats "I'm viewing conv X" to POST /api/presence, and
 * `notifyConversationComplete` skips ALL pushes for a conversation that any of
 * the user's devices is actively viewing (that viewer already receives the
 * message over its live SSE stream, so a push would only double-buzz a second
 * device).
 *
 * Keyed by userId FIRST so a client that posts someone else's conversationId
 * files the entry under its OWN account — the victim's notify check runs under
 * the victim's userId and never matches, so presence can't be abused to
 * griefingly silence another user's notifications. (This is why the heartbeat
 * endpoint needs no ownership DB read.)
 *
 * `viewerId` is a per-page-load id the client mints (App.Locals carries no
 * session identity, and a per-tab id is more precise than a shared session
 * cookie anyway — two tabs on different threads report independently).
 *
 * Module-level Map, single-process — same tradeoff the in-flight registry
 * documents. Multiple replicas would need a shared store; a v2 concern.
 * Entries self-expire: a heartbeat refreshes a viewer's TTL, an explicit
 * `visible:false` (blur / thread-switch / unload) clears it immediately, and a
 * viewer that goes silent (tab crash, no pagehide) ages out within the TTL.
 */

/** How long one heartbeat keeps a viewer "present". The client beats well
 *  inside this (~25s) so a single dropped beat doesn't flip presence off, yet
 *  a hard-crashed tab that never sent `visible:false` stops suppressing within
 *  a minute. */
export const PRESENCE_TTL_MS = 60_000;

// userId -> conversationId -> viewerId -> expiresAt (unix ms)
const presence = new Map<string, Map<string, Map<string, number>>>();

/**
 * Record (or refresh) a viewer's presence on a conversation. `visible:false`
 * clears the viewer immediately rather than waiting for TTL expiry, so a
 * backgrounded or closed window stops suppressing another device promptly.
 */
export function recordPresence(
	userId: string,
	conversationId: string,
	viewerId: string,
	visible: boolean,
	now: number = Date.now(),
): void {
	if (!visible) {
		clearViewer(userId, conversationId, viewerId);
		return;
	}
	let byConv = presence.get(userId);
	if (!byConv) {
		byConv = new Map();
		presence.set(userId, byConv);
	}
	let byViewer = byConv.get(conversationId);
	if (!byViewer) {
		byViewer = new Map();
		byConv.set(conversationId, byViewer);
	}
	byViewer.set(viewerId, now + PRESENCE_TTL_MS);
}

/**
 * True when any of the user's devices is actively viewing this conversation.
 * Prunes expired viewers as it scans (lazy cleanup — there's no background
 * sweeper), so a stale entry from a crashed tab can't keep suppressing past
 * its TTL.
 */
export function isConversationBeingViewed(
	userId: string,
	conversationId: string,
	now: number = Date.now(),
): boolean {
	const byConv = presence.get(userId);
	const byViewer = byConv?.get(conversationId);
	if (!byConv || !byViewer) return false;
	let viewed = false;
	for (const [viewerId, expiresAt] of byViewer) {
		if (expiresAt > now) viewed = true;
		else byViewer.delete(viewerId);
	}
	if (byViewer.size === 0) byConv.delete(conversationId);
	if (byConv.size === 0) presence.delete(userId);
	return viewed;
}

function clearViewer(userId: string, conversationId: string, viewerId: string): void {
	const byConv = presence.get(userId);
	const byViewer = byConv?.get(conversationId);
	if (!byConv || !byViewer) return;
	byViewer.delete(viewerId);
	if (byViewer.size === 0) byConv.delete(conversationId);
	if (byConv.size === 0) presence.delete(userId);
}

/** Test/dev only. */
export function resetPresence(): void {
	presence.clear();
}
