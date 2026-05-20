/// <reference lib="webworker" />
/// <reference types="vite-plugin-pwa/client" />

/**
 * GlyphStream service worker.
 *
 * Two responsibilities:
 *
 * 1. Precache the built static shell so cold loads survive a flaky
 *    network. Only the URLs in `self.__WB_MANIFEST` (injected by
 *    @vite-pwa/sveltekit at build time) are intercepted; /api/*,
 *    SSE streams, and SSR'd HTML pass straight through to the
 *    network. This is the "default route is no route" behavior that
 *    makes injectManifest cleaner than generateSW for our shape.
 *
 * 2. Receive Web Push events from the server's notify pipeline and
 *    arbitrate between three outcomes (see src/lib/sw/arbiter.ts):
 *      - silent (user is on the same thread; SSE delivers it)
 *      - toast (user is in the app but elsewhere; postMessage)
 *      - OS notification (no visible client)
 *
 *    The arbiter is a pure function exercised by unit tests; this
 *    file is the thin worker-glue that maps that decision onto the
 *    SW APIs (clients.postMessage, registration.showNotification).
 */

import { precacheAndRoute } from 'workbox-precaching';
import { pickAction, type ArbiterClient, type ArbiterPayload } from '$lib/sw/arbiter';
import type { NotifyPushPayload } from '$lib/server/push/notify';

// SW context: redeclare `self` with the correct worker-scope type so
// addEventListener and clients/registration narrow correctly.
declare const self: ServiceWorkerGlobalScope & { __WB_MANIFEST: Array<{ url: string; revision: string | null }> };

precacheAndRoute(self.__WB_MANIFEST);

// Activate the new SW immediately on install rather than waiting for
// every controlling client to close. registerType='prompt' in
// vite.config.ts means the user has already opted in to the refresh
// via UpdateBanner by the time we get here.
self.addEventListener('install', () => {
	void self.skipWaiting();
});
self.addEventListener('activate', (event) => {
	event.waitUntil(self.clients.claim());
});

self.addEventListener('push', (event: PushEvent) => {
	event.waitUntil(handlePush(event));
});

async function handlePush(event: PushEvent): Promise<void> {
	let payload: NotifyPushPayload;
	try {
		payload = event.data?.json() as NotifyPushPayload;
	} catch {
		// Malformed payload from a hostile or buggy sender — silently drop.
		return;
	}
	if (!payload || payload.type !== 'message_complete') return;

	const clientsList = await self.clients.matchAll({
		type: 'window',
		includeUncontrolled: true
	});
	const arbiterClients: ArbiterClient[] = clientsList.map((c) => ({
		url: c.url,
		visibilityState: c.visibilityState
	}));
	const arbiterPayload: ArbiterPayload = {
		conversationId: payload.conversationId,
		foregroundToast: payload.foregroundToast
	};

	const action = pickAction(arbiterClients, arbiterPayload);

	if (action === 'silent') return;

	if (action === 'toast') {
		for (let i = 0; i < clientsList.length; i++) {
			if (clientsList[i].visibilityState === 'visible') {
				clientsList[i].postMessage({ kind: 'message_complete_toast', payload });
			}
		}
		return;
	}

	// action === 'os' — raise an OS-level notification.
	await self.registration.showNotification(payload.conversationTitle, {
		body: payload.preview ?? 'New message',
		tag: payload.conversationId,
		data: { conversationId: payload.conversationId },
		icon: '/icon.svg',
		badge: '/icon.svg',
		renotify: true
	} as NotificationOptions);
}

self.addEventListener('notificationclick', (event: NotificationEvent) => {
	event.notification.close();
	const data = event.notification.data as { conversationId?: string } | undefined;
	const conversationId = data?.conversationId;
	if (!conversationId) return;
	event.waitUntil(focusOrOpen(conversationId));
});

async function focusOrOpen(conversationId: string): Promise<void> {
	const targetPath = `/chat/${conversationId}`;
	const clientsList = await self.clients.matchAll({
		type: 'window',
		includeUncontrolled: true
	});
	for (let i = 0; i < clientsList.length; i++) {
		const c = clientsList[i];
		// Same-origin check so we don't try to drive a window we don't own.
		try {
			if (new URL(c.url).origin === self.location.origin) {
				await c.focus();
				c.postMessage({ kind: 'navigate_to_conversation', conversationId });
				return;
			}
		} catch {
			// Malformed client URL — skip.
		}
	}
	await self.clients.openWindow(targetPath);
}
