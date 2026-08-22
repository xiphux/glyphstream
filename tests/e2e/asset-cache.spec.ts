import { readdir } from 'node:fs/promises';
import { test, expect } from '@playwright/test';
import { CHUNK_CACHE_NAME } from '../../src/lib/sw/asset-route';

/**
 * The client bundle has to survive between launches.
 *
 * It didn't. Every hashed chunk is served `max-age=31536000, immutable`, and the
 * assumption was that the browser's own HTTP cache would therefore cover repeat
 * loads — so the service worker precached only the root icons. The debug panel
 * then reported 41 of 41 chunks coming from the network on three consecutive
 * cold launches of an unchanged build, hours apart: WebKit does not reliably
 * keep a standalone web app's disk cache across termination.
 *
 * A cache-first runtime route fixes that, and the only way to prove a cache is
 * really being read is to take the network away. Asserting "it was fast" or
 * "transferSize was 0" would pass just as well on an HTTP-cache hit, which is
 * exactly the thing that turned out not to be there.
 */
test('the client bundle is served from Cache Storage with the network off', async ({
	page,
	context,
}) => {
	const entryDir = 'build/client/_app/immutable/entry';
	const entry = (await readdir(entryDir)).find((f) => f.startsWith('start.') && f.endsWith('.js'));
	expect(entry, 'no start chunk in the build output').toBeTruthy();
	const chunkUrl = `/_app/immutable/entry/${entry}`;

	// First load registers the worker; the reload is what puts it in control, so
	// that chunk requests actually pass through its routes.
	await page.goto('/');
	await page.evaluate(() => navigator.serviceWorker.ready);
	await page.reload();
	await page.waitForFunction(() => !!navigator.serviceWorker.controller);

	const cached = await page
		.waitForFunction(
			async (name) => {
				const keys = await (await caches.open(name)).keys();
				return keys.length > 10 ? keys.length : false;
			},
			CHUNK_CACHE_NAME,
			{ timeout: 15_000 },
		)
		.then((handle) => handle.jsonValue());
	expect(cached, 'the runtime route stored nothing').toBeGreaterThan(10);

	await context.setOffline(true);

	// The control matters as much as the assertion: it proves the network really
	// is gone, so the chunk below cannot have quietly come over the wire.
	const control = await page.evaluate(async () => {
		try {
			await fetch('/api/health');
			return 'reachable';
		} catch {
			return 'offline';
		}
	});
	expect(control, 'network was still reachable, so this proves nothing').toBe('offline');

	const served = await page.evaluate(async (url) => {
		try {
			const res = await fetch(url);
			return { ok: res.ok, bytes: (await res.text()).length };
		} catch (err) {
			return { ok: false, bytes: 0, error: String(err) };
		}
	}, chunkUrl);
	expect(served.ok, `chunk was not served offline: ${JSON.stringify(served)}`).toBe(true);
	expect(served.bytes).toBeGreaterThan(0);
});
