import process from 'node:process';
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
				// theme_color tints Android's browser/toolbar chrome before the
				// page loads; syncThemeColorMeta() takes over from there.
				theme_color: '#0f172a',
				// background_color is Chrome's synthesised launch screen — the
				// Android counterpart of the apple-touch-startup-image set, so it
				// gets the same treatment: the dark `--color-surface` the app
				// actually paints (see scripts/generate-pwa-splash.ts), not the
				// brand navy, which measured ΔE2000 9.5 away from it and flashed.
				// The manifest has no scheme variants, so one value has to serve
				// both; dark is the one that can match exactly, and a light-scheme
				// user's launch is no worse than it already was. The icon's own
				// navy tile now reads as a faint square against this — accepted,
				// it's far below the flash it replaces.
				background_color: '#080b10',
				display: 'standalone',
				start_url: '/',
				scope: '/',
				icons: [
					// SVG is the "any" form — Android/Chrome honor it and it
					// stays crisp at any size. (iOS ignores manifest icons
					// entirely: its home-screen icon comes from the
					// apple-touch-icon PNG in app.html, and its launch image
					// from the apple-touch-startup-image block there — iOS
					// synthesises no splash from `background_color` the way
					// Chrome does, so these icons never feed one.)
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
				// Precache ONLY the root-level, non-hashed assets — the icons the SW
				// itself renders into notifications, plus the manifest. The hashed
				// chunks are cached too, but by a runtime route rather than from this
				// list — see the note at the end of this block. Between them those are
				// the only two routes the SW registers, so /api/*, SSE streams and
				// SSR'd HTML pass straight through to the network.
				//
				// Deliberately NOT `client/**` over js/css. That swept in every hashed
				// chunk — ~380 KB gzip across ~89 entries, including the markdown-it
				// and shiki chunks the route-lazy design exists to defer, and the
				// settings/gallery/admin chunks a given user may never open. Vite's
				// chunk hashes cascade through the import graph, so one shared-module
				// change rehashed many chunks and a large fraction of that re-installed
				// on every deploy, competing with foreground traffic
				// (`registerSW({ immediate: true })` starts right after page load).
				//
				// And there's no navigation fallback here by design — an offline
				// navigation needs SSR HTML that isn't precached either way — so
				// precached JS couldn't make a cold offline load work regardless.
				//
				// This block used to close by saying it bought very little, because
				// `/_app/immutable/*` is content-hashed and already served
				// `max-age=31536000, immutable`, so the browser's own HTTP cache would
				// cover repeat loads. That last part is false on the platform this app
				// is built for: the debug panel reported 41 of 41 chunks coming from
				// the network on three consecutive cold launches of an unchanged build,
				// hours apart, because WebKit does not reliably keep a standalone web
				// app's disk cache across termination. The chunks ARE cached now — by a
				// cache-first RUNTIME route in src/service-worker.ts, which stores only
				// what the app actually fetched and so avoids every cost catalogued
				// above. Precaching is still the wrong tool; caching was not.
				globPatterns: ['client/*.{ico,png,svg,webmanifest}'],
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
	].filter(Boolean),
});
