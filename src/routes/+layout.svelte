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
					const { conversationId, conversationTitle } = data.payload;
					toast.info(conversationTitle, {
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
