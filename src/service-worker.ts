/// <reference lib="webworker" />
/// <reference types="vite-plugin-pwa/client" />

/**
 * GlyphStream service worker.
 *
 * Three responsibilities:
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
 *
 * 3. Keep the home-screen app-icon badge in step with the notification
 *    tray, across the whole notification lifecycle — raised when one is
 *    shown, re-derived when one is tapped or dismissed. The counting
 *    rules live in src/lib/sw/badge.ts; this file just calls them from
 *    the three lifecycle events. Note the badge is not driven by the
 *    arbiter: only the 'os' branch ever puts anything in the tray.
 */

import { precacheAndRoute } from 'workbox-precaching';
import { pickAction, type ArbiterPayload } from '$lib/sw/arbiter';
import { raiseAppBadge, syncAppBadge } from '$lib/sw/badge';
import type { ActiveConversationReport, NotifyPushPayload } from '$lib/types/push';

// SW context: redeclare `self` with the correct worker-scope type so
// addEventListener and clients/registration narrow correctly.
declare const self: ServiceWorkerGlobalScope & {
	__WB_MANIFEST: Array<{ url: string; revision: string | null }>;
	__GLYPHSTREAM_BUILD__: string;
};

// Declared here rather than taken from app.d.ts's `declare global`: SvelteKit
// excludes this file from the app's TS program (different globals/lib — see
// the allowDefaultProject list in eslint.config.js), so that global does not
// reach it and the constant lands as an error type. The value still arrives —
// vite-plugin-pwa builds the worker in its own Vite pass, which inherits the
// root config's `define`.
declare const __APP_VERSION__: string;

precacheAndRoute(self.__WB_MANIFEST);

// Build stamp. Nothing reads it. Its job is to BE BYTES, and to differ
// between releases.
//
// A service-worker update is a byte-for-byte comparison of the newly fetched
// script against the installed one — identical bytes and the browser aborts
// the update before `updatefound`, so registerSW never calls onNeedRefresh
// and UpdateBanner never appears. Every other byte in this worker is stable
// across a release, and since the precache narrowed to seven root-level
// assets that don't change between releases either (0eff6c02), so is the
// injected `__WB_MANIFEST`. The compiled worker was byte-identical across a
// version bump plus a client rebuild, which had quietly retired the update
// prompt: an iOS PWA resumed after a deploy would go on running the old
// client against the new server indefinitely, since a resume re-checks the
// worker but never reloads the page.
//
// Assigning onto `self` rather than leaving an unused const is what keeps a
// minifier from dropping it. The side benefit is that `__GLYPHSTREAM_BUILD__`
// in a DevTools service-worker console says which build is actually active.
self.__GLYPHSTREAM_BUILD__ = __APP_VERSION__;

// Do NOT skipWaiting() on install. `install` fires as soon as the browser
// notices a new worker — long before the user has seen anything — so calling
// it there activates the new worker immediately and the worker never enters
// the `waiting` state. registerType='prompt' (vite.config.ts) is implemented
// by workbox-window, which raises the event behind onNeedRefresh ONLY for a
// waiting worker: skipWaiting here meant the new SW silently claimed the open
// page, UpdateBanner never rendered, and the page went on running the old
// client bundle against the new server until something else reloaded it.
//
// Instead we wait, and let the user's click drive activation: workbox-window's
// updateSW(true) posts SKIP_WAITING to the waiting worker and reloads once the
// controller changes. Dismissing the banner leaves the worker waiting, which
// is what UpdateBanner's own comment already promised.
self.addEventListener('message', (event: ExtendableMessageEvent) => {
	const data = event.data as { type?: string } | undefined;
	if (data?.type === 'SKIP_WAITING') void self.skipWaiting();
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
		includeUncontrolled: true,
	});

	// Ask each window to self-report its route + visibility. WindowClient.url
	// doesn't reliably reflect SvelteKit client-side (pushState) navigation,
	// so the SW can't trust its own view of which conversation a window is
	// on — the window itself is the authority. A window that doesn't answer
	// in time (suspended / closed) is treated as absent.
	const probed = await Promise.all(
		clientsList.map(async (client) => ({ client, report: await queryClient(client) })),
	);
	const reports: ActiveConversationReport[] = [];
	for (const p of probed) {
		if (p.report) reports.push(p.report);
	}

	const arbiterPayload: ArbiterPayload = {
		conversationId: payload.conversationId,
		foregroundToast: payload.foregroundToast,
	};

	const action = pickAction(reports, arbiterPayload);

	if (action === 'silent') return;

	if (action === 'toast') {
		for (const p of probed) {
			if (p.report?.visible) {
				p.client.postMessage({ kind: 'message_complete_toast', payload });
			}
		}
		return;
	}

	// action === 'os' — raise an OS-level notification.
	await self.registration.showNotification(payload.conversationTitle, {
		// A fan-out's count summary ("3 images ready") is non-content and takes
		// precedence; otherwise the message preview (when content is shown).
		body: payload.summary ?? payload.preview ?? 'New message',
		tag: payload.conversationId,
		data: { conversationId: payload.conversationId },
		// Raster, not SVG: Android won't reliably render an SVG notification
		// icon. `badge` is the monochrome status-bar glyph — Android tints it
		// from the alpha channel, so it needs the transparent glyph-only asset
		// (the full-bleed icon would render as a solid blob).
		icon: '/icon-192.png',
		badge: '/badge-96.png',
		renotify: true,
	} as NotificationOptions);

	// Home-screen icon badge, counted from the tray we just added to. Note
	// this is only on the 'os' branch: 'silent' and 'toast' mean the user is
	// already looking at the app, so there is nothing to badge them about.
	await raiseAppBadge(self.registration);
}

/**
 * Ask one window which conversation it's showing and whether it's
 * visible. Uses a MessageChannel so the reply correlates without a
 * shared message bus. Resolves to null if the window doesn't answer
 * within the timeout — a suspended or unresponsive window can't be
 * "actively viewing" anything, so the arbiter treats null as absent.
 */
function queryClient(client: Client, timeoutMs = 500): Promise<ActiveConversationReport | null> {
	return new Promise((resolve) => {
		const channel = new MessageChannel();
		let settled = false;
		const finish = (result: ActiveConversationReport | null) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			channel.port1.onmessage = null;
			resolve(result);
		};
		const timer = setTimeout(() => finish(null), timeoutMs);
		channel.port1.onmessage = (ev: MessageEvent) => {
			const data = ev.data as Partial<ActiveConversationReport> | undefined;
			finish(
				data && typeof data.visible === 'boolean'
					? { conversationId: data.conversationId ?? null, visible: data.visible }
					: null,
			);
		};
		try {
			client.postMessage({ kind: 'query_active_conversation' }, [channel.port2]);
		} catch {
			finish(null);
		}
	});
}

self.addEventListener('notificationclick', (event: NotificationEvent) => {
	event.notification.close();
	const data = event.notification.data as { conversationId?: string } | undefined;
	event.waitUntil(handleNotificationClick(data?.conversationId));
});

/**
 * The badge resync runs even when there's no conversation to open, and
 * even if focusing throws — `close()` above already changed the tray, so
 * leaving the badge un-re-derived would strand a count the user can no
 * longer see the notifications behind. The focused window will also
 * acknowledge the thread when it arrives, but that depends on the page
 * loading; this doesn't.
 */
async function handleNotificationClick(conversationId: string | undefined): Promise<void> {
	try {
		if (conversationId) await focusOrOpen(conversationId);
	} finally {
		await syncAppBadge(self.registration);
	}
}

/**
 * The user swiped the notification away without opening it. Supported
 * unevenly (WebKit in particular), which is why the app-visible resync in
 * the root layout exists as a backstop rather than this being the only
 * path — but where it does fire, it updates the badge immediately instead
 * of at the next app open.
 */
self.addEventListener('notificationclose', (event: NotificationEvent) => {
	event.waitUntil(syncAppBadge(self.registration));
});

async function focusOrOpen(conversationId: string): Promise<void> {
	const targetPath = `/chat/${conversationId}`;
	const clientsList = await self.clients.matchAll({
		type: 'window',
		includeUncontrolled: true,
	});
	for (let i = 0; i < clientsList.length; i++) {
		const c = clientsList[i];
		// Same-origin check so we don't try to drive a window we don't own.
		try {
			if (new URL(c.url).origin === self.location.origin) {
				// Tell the page where it's going BEFORE focusing it. focus() is
				// what makes the window visible, and the chat route reads "I
				// became visible" as the user having seen whatever thread it's
				// parked on — so focusing first briefly presents the OLD
				// conversation and lets it dismiss a notification the user never
				// looked at. Posting first means the navigation is already
				// pending by the time visibility flips, which is the signal the
				// route checks. The openWindow fallback below gains no awaits in
				// front of it, so it keeps its user activation — but note it is
				// no longer reachable from a focus failure; see just below.
				c.postMessage({ kind: 'navigate_to_conversation', conversationId });
				// A focus() rejection (rare — some platforms refuse it without
				// user activation) no longer falls through to openWindow: the
				// page has already been told to navigate, so a new window would
				// just duplicate a thread that's already loading.
				await c.focus().catch(() => {});
				return;
			}
		} catch {
			// Malformed client URL — skip.
		}
	}
	await self.clients.openWindow(targetPath);
}
