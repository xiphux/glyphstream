/**
 * Capture README screenshots against the seeded demo server.
 *
 * Prereqs (see scripts/screenshots/README.md for the full dance):
 *   1. pnpm exec tsx scripts/screenshots/seed.ts
 *   2. node scripts/screenshots/mock-upstream.mjs        (port 3002)
 *   3. pnpm build && <demo env> node build/index.js      (port 3010)
 *   4. pnpm exec tsx scripts/screenshots/capture.ts
 *
 * Output: docs/images/*.png at 2x device scale for crisp rendering on
 * retina displays (README displays them at ~820 CSS px wide).
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium, type Page } from '@playwright/test';

const BASE = process.env.DEMO_BASE_URL ?? 'http://localhost:3010';
const DATA_DIR = resolve('./scripts/screenshots/.demo-data');
const OUT_DIR = resolve('./docs/images');

const manifest = JSON.parse(readFileSync(resolve(DATA_DIR, 'manifest.json'), 'utf8')) as {
	hero: string;
	fanout: string;
};

async function settle(page: Page) {
	await page.waitForLoadState('networkidle');
	// Let entry animations and image decodes finish.
	await page.waitForTimeout(900);
}

const browser = await chromium.launch();
try {
	const context = await browser.newContext({
		storageState: resolve(DATA_DIR, 'auth.json'),
		viewport: { width: 1380, height: 860 },
		deviceScaleFactor: 2,
		colorScheme: 'light',
	});
	const page = await context.newPage();

	// Hero — the active chat conversation, light and dark.
	await page.goto(`${BASE}/chat/${manifest.hero}`);
	await settle(page);
	await page.screenshot({ path: resolve(OUT_DIR, 'hero-light.png') });
	console.log('captured hero-light.png');

	await page.emulateMedia({ colorScheme: 'dark' });
	await settle(page);
	await page.screenshot({ path: resolve(OUT_DIR, 'hero-dark.png') });
	console.log('captured hero-dark.png');

	// Fan-out compare grid (parked image fan-out). Dark scheme — it's the
	// flattering one for media grids.
	await page.goto(`${BASE}/chat/${manifest.fanout}`);
	await settle(page);
	await page.screenshot({ path: resolve(OUT_DIR, 'fanout.png') });
	console.log('captured fanout.png');

	// Gallery.
	await page.goto(`${BASE}/gallery`);
	await settle(page);
	await page.screenshot({ path: resolve(OUT_DIR, 'gallery.png') });
	console.log('captured gallery.png');
} finally {
	await browser.close();
}
console.log(`done — images in ${OUT_DIR}`);
