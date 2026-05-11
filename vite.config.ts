import { sveltekit } from '@sveltejs/kit/vite';
import tailwindcss from '@tailwindcss/vite';
import { SvelteKitPWA } from '@vite-pwa/sveltekit';
import { defineConfig, type PluginOption } from 'vite';
import { visualizer } from 'rollup-plugin-visualizer';

// Enable bundle analysis with `ANALYZE=1 pnpm build`. Generates a
// gzip + brotli treemap at bundle-stats.html in the project root —
// useful for spotting unexpected client-side dependencies (most often:
// shiki accidentally pulled into the browser bundle).
const analyze = process.env.ANALYZE === '1';

export default defineConfig({
	plugins: [
		tailwindcss(),
		sveltekit(),
		SvelteKitPWA({
			// Enable in dev so /manifest.webmanifest resolves and the icon
			// renders the same as in prod. The actual SW registration is
			// still gated by `import.meta.env.PROD` in src/routes/+layout.svelte,
			// so the SW only runs in production builds — only the manifest
			// + assets-served-from-the-plugin path is exercised in dev.
			devOptions: { enabled: true },
			// 'prompt': new SW downloads in the background and waits to
			// activate until the user opts in via the UpdateBanner that
			// renders from +layout.svelte's onNeedRefresh callback.
			// 'autoUpdate' would silently swap the SW on next nav, which
			// can yank an in-flight stream or message-edit out from under
			// the user with no warning. User-driven update means the
			// refresh happens at a moment of their choosing.
			registerType: 'prompt',
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
				// adapter-node serves pages via SSR, not as a static shell, so
				// there's no precached HTML to fall back navigations to.
				// @vite-pwa/sveltekit otherwise auto-sets this to "/" (its
				// `if (!("navigateFallback" in options.workbox))` check is
				// presence-based, so the explicit `undefined` short-circuits
				// it). Without this opt-out, Workbox throws
				// `non-precached-url :: [{"url":"/"}]` when handling the
				// navigation route at runtime.
				navigateFallback: undefined,
				runtimeCaching: [
					{
						urlPattern: /^\/api\//,
						handler: 'NetworkOnly'
					}
				]
			}
		}),
		analyze &&
			(visualizer({
				filename: 'bundle-stats.html',
				template: 'treemap',
				gzipSize: true,
				brotliSize: true,
				open: false
			}) as PluginOption)
	].filter(Boolean) as PluginOption[]
});
