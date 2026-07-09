/**
 * Retract OS notifications for a conversation that no longer exists.
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
 * toast rather than dead-ending on a 404.
 */
export async function dismissConversationNotifications(conversationId: string): Promise<void> {
	if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;
	try {
		// getRegistration(), not `ready` — `ready` never settles when no SW
		// is registered (dev builds), which would leak a pending promise.
		const registration = await navigator.serviceWorker.getRegistration();
		if (!registration?.getNotifications) return;
		const notifications = await registration.getNotifications({ tag: conversationId });
		for (const notification of notifications) notification.close();
	} catch {
		// Best-effort: a stale tray entry is a nuisance, not a failure worth
		// surfacing over the delete that just succeeded.
	}
}
