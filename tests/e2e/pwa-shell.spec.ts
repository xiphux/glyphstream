import { readdir } from 'node:fs/promises';
import { test, expect } from './fixtures/test';

/**
 * The two things @vite-pwa/sveltekit used to provide, now that SvelteKit builds
 * the worker on its own: the manifest, and the worker's precache list.
 *
 * Both fail quietly. The precache list reaches the worker through Vite's
 * `define` (see vite.config.ts), and a build that stops forwarding it leaves the
 * worker throwing a ReferenceError on its first line — it never installs, and
 * nothing on the page says so. Under the plugin, a SvelteKit major did exactly
 * that kind of thing: built clean, shipped no worker.
 */

test('the manifest is served as a manifest', async ({ request }) => {
	const res = await request.get('/manifest.webmanifest');
	expect(res.status()).toBe(200);
	expect(res.headers()['content-type']).toBe('application/manifest+json');
	expect(res.headers()['cache-control']).toBe('no-cache');
	const manifest = (await res.json()) as { name?: string; icons?: unknown[] };
	expect(manifest.name).toBe('GlyphStream');
	expect(manifest.icons?.length).toBeGreaterThan(0);
});

test('the worker installs and precaches the root-level shell', async ({ page }) => {
	// No `await serviceWorker.ready` first: for a worker that throws on load, it
	// never settles, and the test dies on a bare timeout instead of the poll's
	// message below.
	await page.goto('/');

	// Expected from the build output, not a remembered list: every root-level
	// icon static/ shipped, plus the manifest.
	const expected = [
		...(await readdir('build/client'))
			.filter((f) => /\.(ico|png|svg)$/.test(f))
			.map((f) => `/${f}`),
		'/manifest.webmanifest',
	].sort();

	await expect
		.poll(
			() =>
				page.evaluate(async () => {
					const name = (await caches.keys()).find((k) => k.startsWith('workbox-precache'));
					if (!name) return [];
					const keys = await (await caches.open(name)).keys();
					// Workbox stores each entry under its URL plus a revision param.
					return keys.map((r) => new URL(r.url).pathname).sort();
				}),
			{ message: 'the precache never filled', timeout: 15_000 },
		)
		.toEqual(expected);
});
