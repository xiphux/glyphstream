import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import sharp from 'sharp';
import { test, expect } from './fixtures/test';
import { resetData, seedMediaPrompts } from './helpers';

/**
 * Recently deleted, end to end: delete from the gallery, find it in the trash,
 * restore one, delete the other forever.
 *
 * The unit layer covers each query; what it can't see is the seams — the View
 * options link, the trash page's selection driving the right API, a restore
 * reaching the gallery through its fingerprinted memo (a restore that leaves the
 * row counts unchanged once served a stale grid), and the trash tiles asking for
 * their bytes with `?trash=1`. Drop that param and every tile is a broken image
 * while every server test still passes — which is why this spec, unlike the
 * other gallery specs, writes real image files for its rows.
 *
 * Five rows: the gallery memo's fingerprint is built from row counts, and the
 * sibling gallery specs seed 3 and 4 (see the note in gallery-favorites).
 */

const PROMPTS = ['a red kite', 'a green door', 'a blue boat', 'a gold coin', 'a grey cat'];
const MEDIA_DIR = resolve('./tests/.e2e-data/media');
const TILE = 'li[data-tile] img[src*="/api/media/"]';

/** `seedMediaPrompts` writes rows only; give each one real bytes at its
 *  storage path (`e2e/<id>.png`, ids `e2e-media-000N`, newest first). */
async function writeSeedFiles(): Promise<string[]> {
	const png = await sharp({
		create: { width: 16, height: 16, channels: 3, background: { r: 200, g: 80, b: 40 } },
	})
		.png()
		.toBuffer();
	return PROMPTS.map((_, i) => {
		const abs = resolve(MEDIA_DIR, `e2e/e2e-media-${String(i).padStart(4, '0')}.png`);
		mkdirSync(dirname(abs), { recursive: true });
		writeFileSync(abs, png);
		return abs;
	});
}

test.beforeEach(() => {
	resetData();
	seedMediaPrompts(PROMPTS);
});

test('deleted media waits in Recently deleted, and can be restored or deleted forever', async ({
	page,
}) => {
	const files = await writeSeedFiles();
	await page.goto('/gallery');
	await expect(page.locator(TILE)).toHaveCount(5);

	// Delete two from the gallery.
	await page.getByRole('button', { name: 'Select items' }).click();
	// Select-mode labels carry no prompt, so pick by position (newest first):
	// 0 = red kite, 2 = blue boat.
	const cards = page.locator('li[data-tile]');
	await cards.nth(0).getByRole('button').first().click();
	await cards.nth(2).getByRole('button').first().click();
	await page.getByRole('button', { name: 'Delete', exact: true }).click();
	await expect(page.getByText('They stay in Recently deleted for 30 days.')).toBeVisible();
	// The confirm dialog's button, after the toolbar's.
	await page.getByRole('button', { name: 'Delete', exact: true }).last().click();
	await expect(page.locator(TILE)).toHaveCount(3);

	// The trash is a toolbar link at every width.
	await page.getByRole('link', { name: 'Recently deleted' }).click();
	await expect(page).toHaveURL(/\/gallery\/trash$/);

	const red = page.getByRole('button', { name: /^Select image a red kite/ });
	const blue = page.getByRole('button', { name: /^Select image a blue boat/ });
	await expect(red).toBeVisible();
	await expect(blue).toBeVisible();
	await expect(page.getByText('30 days left')).toHaveCount(2);
	// The URL each tile asks for is one the server will actually serve — i.e. the
	// tiles opt in with `?trash=1`. Fetched through `page.request` rather than
	// read off the <img> (`naturalWidth`), because the gallery already loaded
	// these thumbnails at their live URLs, which are `immutable` for a year: a
	// tile that dropped the param would be answered from the browser cache and
	// look fine here while 404ing on any device that hadn't seen it yet.
	for (const tile of [red, blue]) {
		const src = await tile.locator('img').getAttribute('src');
		expect((await page.request.get(src!)).status()).toBe(200);
	}

	// Restore one.
	await red.click();
	await page.getByRole('button', { name: 'Restore' }).click();
	await expect(red).toHaveCount(0);
	await expect(blue).toBeVisible();

	// Delete the other forever: its bytes leave the disk.
	await blue.click();
	await page.getByRole('button', { name: 'Delete forever' }).click();
	await page.getByRole('button', { name: 'Delete forever' }).last().click();
	await expect(page.getByText('Nothing here.')).toBeVisible();
	expect(existsSync(files[2])).toBe(false);
	expect(existsSync(files[0])).toBe(true);

	// The restored item is back in the gallery — served fresh, not from a memo
	// that still remembers it deleted.
	await page.getByRole('link', { name: 'Back to gallery' }).click();
	await expect(page.locator(TILE)).toHaveCount(4);
	await expect(page.getByRole('button', { name: /^Open image a red kite/ })).toBeVisible();
	await expect(page.getByRole('button', { name: /^Open image a blue boat/ })).toHaveCount(0);
});
