import { sveltekit } from '@sveltejs/kit/vite';
import tailwindcss from '@tailwindcss/vite';
import { SvelteKitPWA } from '@vite-pwa/sveltekit';
import { defineConfig } from 'vite';

export default defineConfig({
	plugins: [
		tailwindcss(),
		sveltekit(),
		SvelteKitPWA({
			// Dev mode is opt-in to keep `pnpm dev` snappy and avoid SW
			// surprises while iterating. Test the SW with `pnpm preview` or
			// production builds.
			devOptions: { enabled: false },
			// autoUpdate: SW silently checks for new builds and swaps in on
			// next visit. The plan's "PWA cache poisoning on deploy" gotcha
			// is solved by this — users always end up on the latest shell.
			registerType: 'autoUpdate',
			// We register the SW manually from src/routes/+layout.svelte via
			// the virtual:pwa-register module. 'false' here keeps the plugin
			// from also trying to inject a registration script (which needs
			// extra SvelteKit hook glue to work).
			injectRegister: false,
			manifest: {
				name: 'GlyphStream',
				short_name: 'GlyphStream',
				description: 'Lightweight chat over multiple OpenAI-compatible backends.',
				theme_color: '#0f172a',
				background_color: '#0f172a',
				display: 'standalone',
				start_url: '/',
				scope: '/',
				icons: [
					{
						src: '/icon.svg',
						sizes: 'any',
						type: 'image/svg+xml',
						purpose: 'any maskable'
					}
				]
			},
			workbox: {
				// Precache the built shell. APIs and media stay on network so
				// they're never served stale and SSE streams aren't intercepted.
				globPatterns: ['**/*.{js,css,html,ico,svg,woff2}'],
				navigateFallbackDenylist: [/^\/api\//],
				runtimeCaching: [
					{
						urlPattern: /^\/api\//,
						handler: 'NetworkOnly'
					}
				]
			}
		})
	]
});
