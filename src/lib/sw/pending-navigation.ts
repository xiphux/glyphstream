/**
 * Cold-launch recovery for a tapped notification.
 *
 * `notificationclick` tells the page where to go by postMessage, which is
 * correct and instant for a PWA that is already running. It is a race for one
 * that is NOT: on iOS, tapping a notification relaunches the app first (at the
 * manifest's start_url) and dispatches `notificationclick` to the worker after,
 * so `clients.matchAll()` finds the freshly launched window, posts into it, and
 * returns — while that window is still parsing its bundle and won't add its
 * `serviceWorker` message listener until the root layout's onMount. The message
 * lands on a client with no listener and is dropped: the app opens on whatever
 * start_url gave it, and the thread the user tapped is never opened. Tapping
 * the same notification while the app is still alive works, which is what makes
 * this look intermittent.
 *
 * `clients.openWindow(path)` can't be the answer either — an installed iOS PWA
 * routinely relaunches at start_url regardless of the path passed.
 *
 * So the target is also written down somewhere the page can PULL it from once
 * it is ready, whenever that turns out to be. Cache Storage rather than an SW
 * module variable because the worker can be evicted between the tap and the
 * page asking, and a module global does not survive that; rather than
 * IndexedDB because this is one small record and the Cache API is already in
 * the worker's dependency set.
 *
 * The record is single-use (claiming deletes it) and short-lived, so a target
 * whose launch never arrived cannot lie in wait and hijack an unrelated app
 * open days later.
 *
 * "Single-use" only holds if something always uses it, though, and the write
 * cannot be made conditional to help: from the worker's side a live window and
 * an iOS-relaunched-but-not-yet-listening one are indistinguishable — both match
 * `clients.matchAll()` and both accept the postMessage — so skipping the record
 * when a client is found would skip exactly the case this exists for. The
 * obligation therefore sits on the consuming side, and BOTH paths must discharge
 * it: the page claims on mount for the cold launch, and also claims from its
 * `navigate_to_conversation` handler for the warm tap, which navigates without
 * remounting and would otherwise leave the record armed for the next unrelated
 * page load to trip over.
 */

/** Its own cache — nothing in the SW enumerates or prunes caches, so this
 *  can't be swept up by the asset routes' housekeeping. */
export const PENDING_NAV_CACHE = 'glyphstream-pending-nav';

/** Cache keys must be URLs. This one is never fetched; the origin is a
 *  deliberately unresolvable placeholder so it can't collide with a real
 *  request or be mistaken for one in DevTools. */
export const PENDING_NAV_KEY = 'https://pending-nav.glyphstream.invalid/target';

/**
 * How long a written target stays claimable. Long enough for the slowest cold
 * launch (iOS relaunching a PWA it evicted, on a cold network) by a wide
 * margin; far short of "the user opens the app tomorrow", which is the case
 * this bound exists to exclude.
 */
export const PENDING_NAV_MAX_AGE_MS = 5 * 60 * 1000;

/** Message type the page sends to claim a pending target. Answered over the
 *  caller's port with the conversation id, or null. */
export const CLAIM_PENDING_NAVIGATION = 'CLAIM_PENDING_NAVIGATION';

interface PendingNavigationRecord {
	conversationId: string;
	/** Epoch ms the notification was tapped. */
	at: number;
}

/**
 * Structural, so this module compiles in both window and ServiceWorker scope
 * without either lib's globals in view — the same reason `badge.ts` declares
 * its own navigator shape.
 */
interface PendingNavCacheStorage {
	open(cacheName: string): Promise<{
		match(request: string): Promise<{ json(): Promise<unknown> } | undefined>;
		put(request: string, response: Response): Promise<void>;
		delete(request: string): Promise<boolean>;
	}>;
}

function isRecord(v: unknown): v is PendingNavigationRecord {
	if (typeof v !== 'object' || v === null) return false;
	const r = v as Partial<PendingNavigationRecord>;
	return (
		typeof r.conversationId === 'string' && r.conversationId.length > 0 && typeof r.at === 'number'
	);
}

/**
 * Pure: is a written target still claimable? Anything from the future is
 * treated as stale too — a clock that moved backwards should expire the
 * record, not pin it as permanently fresh.
 */
export function isClaimable(
	record: PendingNavigationRecord,
	now: number,
	maxAgeMs = PENDING_NAV_MAX_AGE_MS,
): boolean {
	const age = now - record.at;
	return age >= 0 && age <= maxAgeMs;
}

/**
 * Write the target a notification tap is headed for. Best-effort and never
 * throws: failing to write it costs the cold-launch navigation, which is
 * exactly what happened before this existed — it must not also break the
 * postMessage path that works today.
 */
export async function recordPendingNavigation(
	cacheStorage: PendingNavCacheStorage,
	conversationId: string,
	now: number,
): Promise<void> {
	try {
		const cache = await cacheStorage.open(PENDING_NAV_CACHE);
		const record: PendingNavigationRecord = { conversationId, at: now };
		await cache.put(
			PENDING_NAV_KEY,
			new Response(JSON.stringify(record), {
				headers: { 'content-type': 'application/json' },
			}),
		);
	} catch {
		// No Cache Storage, quota, private mode — nothing to recover with.
	}
}

/**
 * Read and consume the pending target. Deletes unconditionally once something
 * is there to read: a target that turned out to be too old is as spent as one
 * that was used, and leaving it would only make the next launch re-evaluate it.
 */
export async function claimPendingNavigation(
	cacheStorage: PendingNavCacheStorage,
	now: number,
): Promise<string | null> {
	try {
		const cache = await cacheStorage.open(PENDING_NAV_CACHE);
		const hit = await cache.match(PENDING_NAV_KEY);
		if (!hit) return null;
		// Read the body BEFORE deleting the entry it came from. Chromium backs a
		// matched Response with a blob that outlives the delete, but WebKit is the
		// engine this whole module exists for, and a throw here lands in the catch
		// below as a plain null — silently reinstating the bug being fixed, with no
		// signal anywhere. The order costs nothing, so don't depend on the answer.
		const parsed: unknown = await hit.json();
		await cache.delete(PENDING_NAV_KEY);
		if (!isRecord(parsed)) return null;
		return isClaimable(parsed, now) ? parsed.conversationId : null;
	} catch {
		return null;
	}
}

/**
 * Drop the whole cache. Sign-out cleanup: the record is device-local state
 * naming one user's conversation, and Cache Storage is scoped to the origin,
 * not to the session — so on a shared browser an unspent record could otherwise
 * outlive its owner and route the next person who signs in. Best-effort and
 * never throws; the record expires on its own regardless.
 */
export async function forgetPendingNavigation(cacheStorage: {
	delete(cacheName: string): Promise<boolean>;
}): Promise<void> {
	try {
		await cacheStorage.delete(PENDING_NAV_CACHE);
	} catch {
		// No Cache Storage, or it refused — nothing to forget.
	}
}

/**
 * Window side: ask the controlling worker whether a notification tap is
 * waiting to be honoured. Mirrors `askWorkerBuild` — same MessageChannel
 * shape, same single settle path, same "resolves null when nothing answers"
 * contract (a worker from before this existed won't reply).
 */
export function askPendingNavigation(
	worker: ServiceWorker,
	timeoutMs = 1500,
): Promise<string | null> {
	return new Promise((resolve) => {
		const channel = new MessageChannel();
		let settled = false;
		const finish = (conversationId: string | null) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			channel.port1.onmessage = null;
			resolve(conversationId);
		};
		const timer = setTimeout(() => finish(null), timeoutMs);
		channel.port1.onmessage = (ev: MessageEvent) => {
			finish(typeof ev.data === 'string' ? ev.data : null);
		};
		try {
			worker.postMessage({ type: CLAIM_PENDING_NAVIGATION }, [channel.port2]);
		} catch {
			finish(null);
		}
	});
}
