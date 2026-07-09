import { readFileSync } from 'node:fs';
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

// Read package.json's version at build time and bake it into the bundle
// as `__APP_VERSION__`. Lets a small "v0.3.6" indicator render in the
// sidebar so a user (or future debugging-us) can confirm at a glance
// which build is loaded — useful after pulling an update or testing
// the service-worker refresh flow. Build-time injection means no
// runtime fs read, no API roundtrip, no bundle bloat.
const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf-8')) as {
	version: string;
};

export default defineConfig({
	define: {
		__APP_VERSION__: JSON.stringify(pkg.version),
	},
	// Foundry allocates a unique port per worktree and exposes it as
	// $VITE_PORT so parallel dev servers don't collide. When it's set we
	// bind to it and fail loudly (strictPort) rather than silently drifting
	// to the next free port — the pane's EXTERNAL_BASE_URL is pinned to this
	// exact port, so a silent bump would break OAuth/passkey callbacks.
	// Unset (normal `pnpm dev`) → undefined → Vite's usual 5173.
	server: {
		port: process.env.VITE_PORT ? Number(process.env.VITE_PORT) : undefined,
		strictPort: !!process.env.VITE_PORT,
	},
	plugins: [
		tailwindcss(),
		sveltekit(),
		SvelteKitPWA({
			// 'injectManifest' lets us own the SW code (src/service-worker.ts)
			// rather than letting Workbox auto-generate it. Required for the
			// push + notificationclick handlers — generateSW can't take
			// custom event listeners. We still get workbox-precaching for
			// the static shell; the plugin injects __WB_MANIFEST into our
			// SW source at build time.
			strategies: 'injectManifest',
			srcDir: 'src',
			filename: 'service-worker.ts',
			// Enable in dev so /manifest.webmanifest resolves and the icon
			// renders the same as in prod. The actual SW registration is
			// still gated by `import.meta.env.PROD` in src/routes/+layout.svelte,
			// so the SW only runs in production builds — only the manifest
			// + assets-served-from-the-plugin path is exercised in dev.
			devOptions: { enabled: true, type: 'module' },
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
					// SVG is the "any" form — Android/Chrome honor it and it
					// stays crisp at any size. (iOS ignores manifest icons
					// entirely; its home-screen icon + launch splash come from
					// the apple-touch-icon PNG declared in app.html.)
					{
						src: '/icon.svg',
						sizes: 'any',
						type: 'image/svg+xml',
						purpose: 'any',
					},
					// Maskable PNGs are full-bleed (no rounded corners) so the
					// Android adaptive-icon mask crops them cleanly. The old
					// setup marked the rounded SVG 'any maskable', which let the
					// OS mask clip its corners.
					{
						src: '/icon-192.png',
						sizes: '192x192',
						type: 'image/png',
						purpose: 'maskable',
					},
					{
						src: '/icon-512.png',
						sizes: '512x512',
						type: 'image/png',
						purpose: 'maskable',
					},
				],
			},
			injectManifest: {
				// Precache the built shell. We only register precache routes
				// inside the SW, so /api/* and SSE streams pass through to
				// the network unintercepted — no need for the generateSW-only
				// runtimeCaching/navigateFallback opt-outs.
				globPatterns: ['client/**/*.{js,css,html,ico,png,svg,woff2}'],
			},
		}),
		analyze &&
			(visualizer({
				filename: 'bundle-stats.html',
				template: 'treemap',
				gzipSize: true,
				brotliSize: true,
				open: false,
			}) as PluginOption),
	].filter(Boolean) as PluginOption[],
});
