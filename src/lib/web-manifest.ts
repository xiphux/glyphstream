/**
 * The web app manifest, served at /manifest.webmanifest by
 * src/routes/manifest.webmanifest/+server.ts and linked from app.html.
 *
 * A module rather than a file under static/ so the reasoning behind each value
 * can sit next to it (JSON has no comments, and several of these were wrong
 * once). vite.config.ts also imports it, to hash it into the service worker's
 * precache list — so it must stay import-free: that file is loaded by Vite's
 * config loader, which resolves no `#lib` alias.
 */
const manifest = {
	name: 'GlyphStream',
	short_name: 'GlyphStream',
	description: 'Lightweight chat over multiple OpenAI-compatible backends.',
	// vite-plugin-pwa added this default when it generated the manifest; kept so
	// dropping the plugin didn't change what installs see.
	lang: 'en',
	// theme_color tints Android's browser/toolbar chrome before the
	// page loads; syncSurfaceChrome() takes over from there. Same
	// value and same reasoning as background_color below: it was
	// `#0f172a`, the brand navy off icon.svg's tile, which is Tailwind
	// slate-900 and nowhere on the Signature ramp — ΔE2000 9.5 from the
	// surface the app actually paints. That fix landed on
	// background_color and missed this field, leaving the manifest
	// stating one pre-load color and app.html's <meta name="theme-color">
	// stating another.
	theme_color: '#080b10',
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
};

/**
 * The exact bytes served. One serialization, shared by the route and by the
 * precache revision in vite.config.ts — hash a different string than the one
 * sent and the revision stops tracking the content.
 */
export const WEB_MANIFEST_JSON = JSON.stringify(manifest);
