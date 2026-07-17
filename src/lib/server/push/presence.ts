/**
 * Ephemeral cross-device viewer presence for notification suppression.
 *
 * The push pipeline fires on every completion and the service worker
 * arbitrates locally — but a device's SW can only see its OWN windows, so it
 * can't tell you're watching the same thread on another device. That's the
 * gap that makes the phone buzz while you watch a response finish on the
 * desktop. This registry closes it: while a chat window is actively RENDERING
 * a generation for conv X (streaming its turn / fan-out, or polling a
 * recovered in-flight one) it heartbeats to POST /api/presence, and
 * `notifyConversationComplete` skips ALL pushes for a conversation that any of
 * the user's devices is rendering (that device shows the message in place, so
 * a push would only double-buzz a second device).
 *
 * Presence tracks "is rendering", NOT "is merely looking at the thread": a tab
 * parked on a conversation it didn't generate holds no stream and would show
 * stale content, so counting it would silence a completion nobody sees. The
 * client only heartbeats while its `generating` signal is true (see
 * stream-presence.svelte.ts + the root layout).
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
 *
 * Entries are reclaimed three ways: an explicit `visible:false` (blur /
 * thread-switch / unload) clears immediately; a lazy prune on read drops
 * expired viewers whenever a conversation is checked at notify time; and a
 * throttled global sweep on write catches the leak the first two miss — a
 * viewer whose tab crashed without a `visible:false` on a conversation that
 * never completes another message (so its lazy prune never runs). The sweep
 * piggybacks on heartbeat writes, so growth and reclamation are driven by the
 * same signal: the map only accretes while clients are beating, and those same
 * beats trigger the sweep.
 */

/** How long one heartbeat keeps a viewer "present". The client beats well
 *  inside this (~25s) so a single dropped beat doesn't flip presence off, yet
 *  a hard-crashed tab that never sent `visible:false` stops suppressing within
 *  a minute. */
export const PRESENCE_TTL_MS = 60_000;

/** Minimum spacing between global sweeps — bounds sweep cost to at most once
 *  per interval regardless of heartbeat volume. Comfortably above the TTL so a
 *  sweep only ever reclaims already-expired entries. */
const SWEEP_INTERVAL_MS = 5 * 60_000;

// userId -> conversationId -> viewerId -> expiresAt (unix ms)
const presence = new Map<string, Map<string, Map<string, number>>>();

/** Unix ms of the last global sweep; gates {@link maybeSweep}. */
let lastSweepAt = 0;

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
	maybeSweep(now);
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
 * True when any of the user's devices is actively rendering this conversation.
 * Prunes expired viewers as it scans (lazy cleanup, complemented by the
 * throttled write-path {@link maybeSweep} for conversations that never reach
 * this read), so a stale entry from a crashed tab can't keep suppressing past
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

/**
 * Reclaim every expired viewer across all users, at most once per
 * {@link SWEEP_INTERVAL_MS}. Called from the write path so a crashed tab on a
 * never-completing conversation (which the read-time prune never reaches) can't
 * pin memory indefinitely.
 */
function maybeSweep(now: number): void {
	if (now - lastSweepAt < SWEEP_INTERVAL_MS) return;
	lastSweepAt = now;
	for (const [userId, byConv] of presence) {
		for (const [conversationId, byViewer] of byConv) {
			for (const [viewerId, expiresAt] of byViewer) {
				if (expiresAt <= now) byViewer.delete(viewerId);
			}
			if (byViewer.size === 0) byConv.delete(conversationId);
		}
		if (byConv.size === 0) presence.delete(userId);
	}
}

/** Test/dev only. */
export function resetPresence(): void {
	presence.clear();
	lastSweepAt = 0;
}

/** Test-only: total viewer entries currently held, WITHOUT pruning (so a test
 *  can distinguish a real reclamation from a lazy read-time prune). */
export function presenceEntryCount(): number {
	let n = 0;
	for (const byConv of presence.values())
		for (const byViewer of byConv.values()) n += byViewer.size;
	return n;
}
