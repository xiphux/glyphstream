<script lang="ts">
	import '../app.css';
	import { onMount } from 'svelte';
	import favicon from '$lib/assets/favicon.svg';
	import UpdateBanner from '$lib/components/UpdateBanner.svelte';

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
				}
				// onOfflineReady intentionally omitted — we don't want a
				// "ready offline" toast on the very first SW install; the
				// app already works fine before then.
			});
			// updateSW(true) activates the waiting SW and reloads. We pin
			// it to a state slot so the banner's click handler can call it.
			triggerUpdate = () => updateSW(true);
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
