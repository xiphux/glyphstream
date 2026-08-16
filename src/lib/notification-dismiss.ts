/**
 * Retract the OS notifications for a conversation the user is done with,
 * and re-derive the app-icon badge from what's left in the tray.
 *
 * Two callers, same mechanics:
 *  - the conversation was deleted, so its notification points at nothing;
 *  - the user is *looking at* the conversation, which is the acknowledgment
 *    the notification was asking for (see the chat route).
 *
 * The SW tags every notification it raises with the conversation id
 * (see `showNotification` in src/service-worker.ts), which is what makes
 * them addressable after the fact: `getNotifications({ tag })` returns
 * the ones still sitting in the tray.
 *
 * Scope: this only clears the tray on *this* device. Retracting on the
 * user's other devices would need a content-less push, and iOS revokes a
 * subscription that receives pushes it doesn't render — so a deleted
 * conversation's notification can still be tapped from another phone.
 * The chat route's load handles that case by redirecting home with a
 * toast rather than dead-ending on a 404. The badge inherits the same
 * per-device scope for the same reason.
 */

import { syncAppBadge } from '$lib/sw/badge';

export async function dismissConversationNotifications(conversationId: string): Promise<void> {
	if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;
	let registration: ServiceWorkerRegistration | undefined;
	try {
		// getRegistration(), not `ready` — `ready` never settles when no SW
		// is registered (dev builds), which would leak a pending promise.
		registration = await navigator.serviceWorker.getRegistration();
		// Nested rather than an early return, so every path reaches the badge
		// resync below — an early return here would skip it.
		if (registration?.getNotifications) {
			const notifications = await registration.getNotifications({ tag: conversationId });
			for (const notification of notifications) notification.close();
		}
	} catch {
		// Best-effort: a stale tray entry is a nuisance, not a failure worth
		// surfacing over the delete that just succeeded.
	}
	// After the closes, not before — the badge counts what remains. Reached on
	// the failure paths too, where it's a no-op by construction: a registration
	// that's undefined or can't be queried reads as "unknown", which leaves the
	// badge untouched rather than clearing it.
	await syncAppBadge(registration);
}
