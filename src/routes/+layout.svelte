<script lang="ts">
	import '../app.css';
	import { onMount } from 'svelte';
	import favicon from '$lib/assets/favicon.svg';

	let { children } = $props();

	onMount(async () => {
		// Register the service worker (production builds only — the dev
		// build of the PWA plugin is disabled in vite.config.ts). Dynamic
		// import keeps this out of the SSR bundle; the virtual module
		// resolves at client build time via vite-plugin-pwa.
		if ('serviceWorker' in navigator && import.meta.env.PROD) {
			// @ts-expect-error virtual:pwa-register has runtime types via the
			// PWA plugin but isn't resolvable by tsc at lint time.
			const { registerSW } = await import('virtual:pwa-register');
			registerSW({ immediate: true });
		}
	});
</script>

<svelte:head>
	<link rel="icon" href={favicon} />
	<title>GlyphStream</title>
</svelte:head>

{@render children()}
