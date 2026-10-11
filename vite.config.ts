import adapter from '@sveltejs/adapter-node';
import process from 'node:process';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { sveltekit } from '@sveltejs/kit/vite';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig, type PluginOption } from 'vite';
import { visualizer } from 'rollup-plugin-visualizer';
import { WEB_MANIFEST_JSON } from './src/lib/web-manifest.ts';

// Load .env into process.env, where $lib/server/env.ts reads everything (see
// the note at its top for why not a Kit env module). Vite reads .env only for
// its own `import.meta.env`, so without this `pnpm dev` would start with none
// of it. Variables already set win, as they did under Kit. A missing file is
// fine: production gets its environment from the host or container.
try {
	process.loadEnvFile();
} catch {
	// no .env
}

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

// The service worker's precache list, handed to src/service-worker.ts as
// `__PRECACHE_MANIFEST__`. SvelteKit builds the worker in its own Vite pass but
// passes this config's `define` through to it, the same way `__APP_VERSION__`
// arrives there.
//
// Precache ONLY the root-level, non-hashed assets in static/ — the icons the SW
// itself renders into notifications, plus the manifest. The hashed
// chunks are cached too, but by a runtime route rather than from this
// list — see the note at the end of this block. Between them those are
// the only two routes the SW registers, so /api/*, SSE streams and
// SSR'd HTML pass straight through to the network.
// Deliberately NOT `client/**` over js/css. That swept in every hashed
// chunk — ~380 KB gzip across ~89 entries, including the markdown-it
// and shiki chunks the route-lazy design exists to defer, and the
// settings/gallery/admin chunks a given user may never open. Vite's
// chunk hashes cascade through the import graph, so one shared-module
// change rehashed many chunks and a large fraction of that re-installed
// on every deploy, competing with foreground traffic
// (registration starts right after page load).
// And there's no navigation fallback here by design — an offline
// navigation needs SSR HTML that isn't precached either way — so
// precached JS couldn't make a cold offline load work regardless.
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
// Revisions are content hashes, so the list — and with it the worker's bytes —
// changes only when an icon or the manifest does. (Something else has to make
// the worker differ between releases; see the build stamp in the worker.)
const revision = (bytes: string | Buffer) =>
	createHash('sha256').update(bytes).digest('hex').slice(0, 16);
const staticDir = new URL('./static/', import.meta.url);
const precacheManifest = [
	...readdirSync(staticDir, { withFileTypes: true })
		.filter((f) => f.isFile() && /\.(ico|png|svg)$/.test(f.name))
		.map((f) => ({
			url: `/${f.name}`,
			revision: revision(readFileSync(new URL(f.name, staticDir))),
		})),
	{ url: '/manifest.webmanifest', revision: revision(WEB_MANIFEST_JSON) },
];

export default defineConfig({
	define: {
		__APP_VERSION__: JSON.stringify(pkg.version),
		__PRECACHE_MANIFEST__: JSON.stringify(precacheManifest),
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
		sveltekit({
			compilerOptions: {
				runes: ({ filename }) =>
					filename.split(/[/\\]/).includes('node_modules') ? undefined : true,
			},

			// precompress: build-time gzip + brotli for every static asset.
			// adapter-node's sirv serves the right one based on Accept-Encoding,
			// no per-request CPU cost. A reverse proxy in front (Caddy/Nginx)
			// can also pick up the .gz/.br variants directly via try_files.
			adapter: adapter({ precompress: true }),

			// SvelteKit builds src/service-worker.ts, but registration is ours:
			// $lib/sw/register.ts, from the root layout. Kit's own registration is
			// a bare `register()` in every page's inline script, with none of the
			// update-prompt wiring, so left on it would race ours for the same URL.
			serviceWorker: { register: false },
			// Content-Security-Policy — defense in depth against any XSS that
			// slips past our explicit sinks (markdown-it runs with `html: false`
			// and the three `{@html}` sites all hold server-controlled HTML,
			// but a real CSP raises the cost of any future mistake by an order
			// of magnitude).
			//
			// mode: 'auto' — SvelteKit scans the rendered HTML for inline
			// <script>/<style> blocks and adds their hashes (for prerendered
			// routes) or per-response nonces (for dynamic SSR). That covers
			// SvelteKit's own hydration script AND the IIFEs in app.html that
			// resolve color scheme / GPU blur pre-paint.
			// 'unsafe-inline' on style-src is required because of three inline
			// `style="..."` attributes (composer padding, two safe-area
			// insets) plus the `style="display: contents"` wrapper app.html
			// puts around %sveltekit.body%. Inline style ATTRIBUTES can't be
			// hashed or nonced — only `<style>` blocks can — so 'unsafe-inline'
			// is unavoidable without a refactor for marginal gain. Style-based
			// XSS is a narrow class (mostly CSS exfiltration via :target /
			// attribute selectors); the script-src lockdown is the
			// load-bearing protection here.
			// connect-src 'self': every API call (streaming SSE included) is
			// same-origin — outbound calls to upstream LLMs / search go through
			// the server's relay, not direct from the browser. img-src adds
			// `data:` (cheap future-proofing) and `blob:` (the composer's
			// `URL.createObjectURL` previews of attachments before upload).
			// media-src adds `blob:` for the same composer preview path on
			// videos. frame-ancestors 'none' pairs with the X-Frame-Options:
			// DENY header set in hooks.server.ts.
			csp: {
				mode: 'auto',
				directives: {
					'default-src': ['self'],
					// The sha256 below pins the inline <script> in src/app.html
					// (the pre-paint color-scheme + GPU-blur IIFEs). SvelteKit's
					// CSP nonces its own injected scripts but does NOT
					// auto-hash user-authored inline scripts in app.html, so
					// without this pin the dev server refuses to execute it
					// (and dropping it to an external file would cost a
					// render-blocking request and reintroduce a FOUC window).
					//
					// If you edit that inline script, this hash goes stale and the
					// script is silently BLOCKED — the page still works, because the
					// layout re-applies the scheme after hydration, so the only
					// symptom is the FOUC this pin exists to prevent, plus a blur
					// probe that never runs. It went stale once exactly that way.
					// `tests/unit/csp-inline-script-hash.test.ts` recomputes it from
					// app.html and fails with the value to paste here.
					'script-src': ['self', 'sha256-Ar3Hg1mVpvhki2BhDuALtdbJXW94wX8y3ugNbQnpA3A='],
					'style-src': ['self', 'unsafe-inline'],
					'img-src': ['self', 'data:', 'blob:'],
					'media-src': ['self', 'blob:'],
					'connect-src': ['self'],
					'font-src': ['self', 'data:'],
					'worker-src': ['self'],
					'object-src': ['none'],
					'base-uri': ['self'],
					'form-action': ['self'],
					'frame-ancestors': ['none'],
					'frame-src': ['none'],
				},
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
