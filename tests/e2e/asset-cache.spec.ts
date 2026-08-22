import { readdir, stat } from 'node:fs/promises';
import { test, expect } from '@playwright/test';
import { CHUNK_CACHE_NAME, CHUNK_CACHE_MAX_ENTRIES } from '../../src/lib/sw/asset-route';

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
 * A cache-first runtime route fixes that. Proving it takes offline AND
 * `cache: 'no-store'` together, and it is worth stating what was measured rather
 * than which layer refuses the load — two reviewers have reasoned their way to
 * opposite conclusions about that, in both directions.
 *
 * Measured, with the route removed and the network off: a plain fetch of this
 * chunk SUCCEEDS, and the same fetch with `no-store` FAILS. Something below the
 * worker still answers a bare offline fetch for a URL this document already
 * loaded — so offline alone proves nothing here, and would pass with no service
 * worker at all. `no-store` defeats whatever that is, while leaving the worker's
 * `fetch` handler in the path, because `Cache.match` never consults a request's
 * cache mode. A success under both conditions can therefore only be Cache
 * Storage. ("It was fast" and `transferSize === 0` are weaker still — both pass
 * on that same non-worker hit.)
 *
 * Two traps for anyone rebuilding a control here. Unregistering the worker does
 * not give you an un-serviced page — the app re-registers on the next load and
 * the new worker claims the document within a second or two, so a control that
 * only checks `controller` immediately after reload measures the route it
 * believes it removed. And `context.route()` disables Chromium's HTTP cache
 * wholesale, which quietly invalidates any cache experiment built on it.
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
			// `no-store` is load-bearing, not hygiene — see the note above.
			const res = await fetch(url, { cache: 'no-store' });
			// arrayBuffer, not text().length — the latter counts UTF-16 code units,
			// which only equals the byte count for pure-ASCII content. Most chunks
			// in a real build are not.
			return { ok: res.ok, bytes: (await res.arrayBuffer()).byteLength };
		} catch (err) {
			return { ok: false, bytes: 0, error: String(err) };
		}
	}, chunkUrl);
	expect(served.ok, `chunk was not served offline: ${JSON.stringify(served)}`).toBe(true);

	// Byte-exact against the file on disk, because `bytes > 0` would accept a
	// truncated or error body the route stored by mistake. Cache Storage holds
	// the DECODED body, so this equals the raw file even though the chunk ships
	// precompressed alongside .br/.gz siblings at the same URL.
	const onDisk = (await stat(`${entryDir}/${entry}`)).size;
	expect(served.bytes, 'cached body does not match the built file').toBe(onDisk);
});

test('the cache is sized for more than one build of the real bundle', async () => {
	// The entry cap only delivers its promise — a deploy must not evict the
	// chunks the still-open page is running from — while two builds fit inside
	// it. Counted from the actual build output rather than a remembered figure,
	// so growth past the cap trips here instead of silently degrading a deploy
	// into a mid-session refetch on the platform this route exists for.
	const root = 'build/client/_app/immutable';
	const files = await readdir(root, { recursive: true, withFileTypes: true });
	const assets = files.filter(
		(f) => f.isFile() && !f.name.endsWith('.br') && !f.name.endsWith('.gz'),
	);
	expect(assets.length, 'no build output to size against').toBeGreaterThan(0);
	expect(
		CHUNK_CACHE_MAX_ENTRIES,
		`${assets.length} assets per build needs room for two`,
	).toBeGreaterThanOrEqual(assets.length * 2);
});
