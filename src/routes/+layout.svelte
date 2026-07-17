<script lang="ts">
	import '../app.css';
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import favicon from '$lib/assets/favicon.svg';
	import UpdateBanner from '$lib/components/UpdateBanner.svelte';
	import { toast } from '$lib/toast.svelte';
	import type { ActiveConversationReport, SwClientMessage } from '$lib/types/push';

	let { children } = $props();

	// Presence heartbeat. Tells the server which conversation this window is
	// actively viewing so notifyConversationComplete can suppress a redundant
	// push to this user's OTHER devices while one is watching the thread — the
	// per-device SW arbiter can't see across devices. Reuses the exact signal
	// the arbiter trusts: the page's real SPA route (page.params.id) + the
	// document's visibility. viewerId is per-page-load (per-tab precision;
	// App.Locals carries no session identity anyway).
	const HEARTBEAT_MS = 25_000;
	let presenceViewerId: string | null = null;
	// The conversation we last told the server about — lets a thread switch
	// clear the thread we left before announcing the new one.
	let lastReportedConv: string | null = null;

	function postPresence(conversationId: string, visible: boolean) {
		if (!presenceViewerId) return;
		void fetch('/api/presence', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ conversationId, viewerId: presenceViewerId, visible }),
			// keepalive lets the visible:false beat survive an unloading page.
			keepalive: true,
		}).catch(() => {});
	}

	// One-time setup + teardown. Reads no reactive state, so it runs once on
	// mount and cleans up on destroy (browser-only — effects don't run in SSR).
	$effect(() => {
		presenceViewerId ??= crypto.randomUUID();
		const beat = () => {
			if (lastReportedConv && document.visibilityState === 'visible') {
				postPresence(lastReportedConv, true);
			}
		};
		const onVisibility = () => {
			if (lastReportedConv) postPresence(lastReportedConv, document.visibilityState === 'visible');
		};
		const onPageHide = () => {
			if (lastReportedConv) postPresence(lastReportedConv, false);
		};
		document.addEventListener('visibilitychange', onVisibility);
		window.addEventListener('pagehide', onPageHide);
		const heartbeat = setInterval(beat, HEARTBEAT_MS);
		return () => {
			clearInterval(heartbeat);
			document.removeEventListener('visibilitychange', onVisibility);
			window.removeEventListener('pagehide', onPageHide);
		};
	});

	// React to navigation: on a thread switch (or leaving chat entirely) clear
	// the conversation we left, then announce the new one if it's visible.
	$effect(() => {
		const conv = page.params.id ?? null;
		if (conv === lastReportedConv) return;
		if (lastReportedConv) postPresence(lastReportedConv, false);
		lastReportedConv = conv;
		if (conv && document.visibilityState === 'visible') postPresence(conv, true);
	});

	// When a new SW is waiting, vite-plugin-pwa fires onNeedRefresh and
	// returns an updateSW() we can call when the user opts in. We surface
	// the prompt via UpdateBanner rather than silently reloading the page
	// (registerType='prompt' in vite.config.ts) — silent reloads can yank
	// in-flight streams or unsaved drafts out from under the user.
	let updateAvailable = $state(false);
	let triggerUpdate: (() => void) | null = $state(null);

	onMount(async () => {
		// Register the service worker (production builds only — the dev
		// build of the PWA plugin is disabled in vite.config.ts). Dynamic
		// import keeps this out of the SSR bundle; the virtual module
		// resolves at client build time via vite-plugin-pwa.
		if ('serviceWorker' in navigator && import.meta.env.PROD) {
			// @ts-expect-error virtual:pwa-register has runtime types via the
			// PWA plugin but isn't resolvable by tsc at lint time.
			const { registerSW } = await import('virtual:pwa-register');
			const updateSW = registerSW({
				immediate: true,
				onNeedRefresh() {
					updateAvailable = true;
				},
				// onOfflineReady intentionally omitted — we don't want a
				// "ready offline" toast on the very first SW install; the
				// app already works fine before then.
				onRegisteredSW(_swUrl: string, registration: ServiceWorkerRegistration | undefined) {
					// `immediate: true` only checks for a new SW once, at
					// registration. After that the browser re-checks on a
					// full in-scope navigation — which never happens in an
					// SPA — or its own ~24h timer. On an iOS standalone PWA
					// the process is suspended in the background, so neither
					// fires during normal use: the only update check is a
					// cold launch, i.e. force-quit + reopen. We add our own.
					if (!registration) return;

					const checkForUpdate = () => {
						// The load-bearing trigger on iOS: visibilitychange
						// fires the instant the user swipes back into the PWA,
						// which is exactly when a waiting version should be
						// detected. update() rejects when offline — swallow it
						// and we'll retry on the next focus or interval tick.
						if (document.visibilityState === 'visible') {
							registration.update().catch(() => {});
						}
					};
					document.addEventListener('visibilitychange', checkForUpdate);

					// Belt-and-suspenders for long-lived foreground sessions
					// (a desktop tab left open all day) where visibilitychange
					// never fires. Suspended on iOS, so it can't be the only
					// mechanism — the focus listener above carries that case.
					setInterval(checkForUpdate, 60 * 60 * 1000); // hourly
				},
			});
			// updateSW(true) activates the waiting SW and reloads. We pin
			// it to a state slot so the banner's click handler can call it.
			triggerUpdate = () => updateSW(true);
		}

		// SW -> client messages: the push handler posts these when a
		// thread completes for a user on a different page (toast) or
		// when an OS notification is clicked (navigate). The SW only
		// posts when the action is *meant* for this client; we don't
		// need to re-arbitrate here. Registered unconditionally because
		// in dev there's still a `serviceWorker` object available, even
		// when the SW itself isn't registered — the listener just stays
		// quiet.
		if ('serviceWorker' in navigator) {
			navigator.serviceWorker.addEventListener('message', (ev) => {
				const data = ev.data as SwClientMessage | undefined;
				if (!data) return;
				if (data.kind === 'query_active_conversation') {
					// The SW is arbitrating a push and needs to know —
					// authoritatively, from the page itself — which
					// conversation this window is on and whether it's
					// visible. WindowClient.url can't be trusted for SPA
					// routes, so we answer over the port the SW handed us.
					ev.ports[0]?.postMessage({
						conversationId: page.params.id ?? null,
						visible: document.visibilityState === 'visible',
					} satisfies ActiveConversationReport);
					return;
				}
				if (data.kind === 'message_complete_toast') {
					const { conversationId, conversationTitle, summary } = data.payload;
					toast.info(conversationTitle, {
						// Fan-out's "N ready" count, when present.
						...(summary ? { description: summary } : {}),
						action: { label: 'Open', handler: () => goto(`/chat/${conversationId}`) },
						duration: 6000,
					});
				} else if (data.kind === 'navigate_to_conversation') {
					void goto(`/chat/${data.conversationId}`);
				}
			});
		}
	});

	function dismissUpdate() {
		updateAvailable = false;
	}
</script>

<svelte:head>
	<link rel="icon" href={favicon} />
	<title>GlyphStream</title>
</svelte:head>

{@render children()}

{#if updateAvailable && triggerUpdate}
	<UpdateBanner onRefresh={triggerUpdate} onDismiss={dismissUpdate} />
{/if}
