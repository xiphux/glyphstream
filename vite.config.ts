import process from 'node:process';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { sveltekit } from '@sveltejs/kit/vite';
import { sveltekitOptions } from './sveltekit.config.ts';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig, type PluginOption } from 'vite';
import { visualizer } from 'rollup-plugin-visualizer';
import { WEB_MANIFEST_JSON } from './src/lib/web-manifest.ts';

// Load .env into process.env, where #lib/server/env.ts reads everything (see
// the note at its top for why not a Kit env module). Vite reads .env only for
// its own `import.meta.env`, so without this `pnpm dev` would start with none
// of it. Variables already set win, as they did under Kit. A missing file is
// fine: production gets its environment from the host or container. Checked up
// front rather than caught: Node reports an UNREADABLE .env as ENOENT too, so a
// catch could not tell "absent" from "broken", and a broken one should fail
// here, on the real cause, not later on whichever variable is read first.
if (existsSync('.env')) process.loadEnvFile();

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
//
// Deliberately NOT `client/**` over js/css. That swept in every hashed
// chunk — ~380 KB gzip across ~89 entries, including the markdown-it
// and shiki chunks the route-lazy design exists to defer, and the
// settings/gallery/admin chunks a given user may never open. Vite's
// chunk hashes cascade through the import graph, so one shared-module
// change rehashed many chunks and a large fraction of that re-installed
// on every deploy, competing with foreground traffic
// (registration starts right after page load).
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
//
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
		sveltekit(sveltekitOptions),

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
