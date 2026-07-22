import { test, expect, type Page } from '@playwright/test';
import { resetData, seedMedia, seedMediaInBuckets } from './helpers';

/**
 * Gallery grid virtualization (layout-driven / demand-paged). The server computes
 * the stacked layout up front (per-day unit counts); the client reserves exact
 * scroll height from those counts immediately, then streams thin unit descriptors
 * for only the ranges near the viewport — rendering placeholder tiles until they
 * land. So, unlike the old append-pagination:
 *   - the full unit total is known from first paint (data-loaded-count),
 *   - the scroll height is reserved up front and does NOT grow as you scroll,
 *   - the rendered DOM stays bounded no matter how much has loaded.
 *
 * seedMedia rows have distinct prompts and no conversation, so each is its own
 * solo unit → `unit count == media count`.
 *
 * Clean slate + fresh seed per test (one shared DB across projects — see
 * helpers.resetData).
 */

const SEED_COUNT = 150;

// The scroll container carries the TOTAL unit count (known up front from the
// layout), independent of how many unit descriptors have actually streamed in.
const LOADED = '[data-loaded-count]';
// Every rendered cell (real tile or not-yet-loaded placeholder).
const TILE = '[data-tile]';
// A real, loaded image tile — placeholders have no <img>. Distinguishes
// "reserved but unloaded" from "streamed in".
const REAL = 'img[src*="/api/media/"]';

async function scrollHeight(page: Page): Promise<number> {
	return page.evaluate(
		(sel) => document.querySelector<HTMLElement>(sel)?.scrollHeight ?? 0,
		LOADED,
	);
}
async function scrollToBottom(page: Page): Promise<void> {
	await page.evaluate((sel) => {
		const el = document.querySelector<HTMLElement>(sel);
		if (el) el.scrollTop = el.scrollHeight;
	}, LOADED);
}

test.beforeEach(() => {
	resetData();
	seedMedia(SEED_COUNT);
});

test.describe('gallery: layout-driven virtualization', () => {
	test('knows the full unit total from first paint (no "Load more")', async ({ page }) => {
		await page.goto('/gallery');
		await expect(page.getByRole('heading', { name: 'Gallery' })).toBeVisible();

		// The whole count is reserved immediately — not a first page of 60.
		await expect(page.locator(LOADED)).toHaveAttribute('data-loaded-count', String(SEED_COUNT));
		await expect(page.getByRole('button', { name: 'Load more' })).toHaveCount(0);
	});

	test('reserves scroll height up front — the scrollbar does not grow as you scroll', async ({
		page,
	}) => {
		await page.goto('/gallery');
		await expect(page.locator(REAL).first()).toBeVisible();
		// Let mount reload (real tz) + geometry measurement settle so the full
		// height is reserved.
		await page.waitForTimeout(700);

		const top = await scrollHeight(page);
		expect(top).toBeGreaterThan(1000); // many rows reserved, not just a page

		await scrollToBottom(page);
		await page.waitForTimeout(400);
		const bottom = await scrollHeight(page);

		// The key property vs. the old append-pagination: height is reserved from
		// the layout, so it stays put (within a row's slack) instead of jumping as
		// pages load.
		expect(Math.abs(bottom - top)).toBeLessThan(300);
	});

	test('keeps the rendered tile count bounded while windowing the full set', async ({ page }) => {
		await page.goto('/gallery');
		await expect(page.locator(REAL).first()).toBeVisible();
		await page.waitForTimeout(700);

		// 150 units reserved, but only the viewport window is in the DOM.
		const rendered = await page.locator(TILE).count();
		expect(rendered).toBeGreaterThan(0);
		expect(rendered).toBeLessThan(SEED_COUNT);
	});

	test('demand-loads unit ranges as you scroll (bottom tiles materialize)', async ({ page }) => {
		await page.goto('/gallery');
		await expect(page.locator(REAL).first()).toBeVisible();
		await page.waitForTimeout(700);

		// Scroll to the bottom; the last rendered cell is one of the newest-oldest
		// units, initially outside the SSR-seeded first page. It must resolve from a
		// placeholder to a real image via demand-load.
		await scrollToBottom(page);
		await expect(page.locator(TILE).last().locator('img')).toBeVisible({ timeout: 10_000 });
		// Still bounded after loading the tail.
		expect(await page.locator(TILE).count()).toBeLessThan(SEED_COUNT);
	});

	test('tiles stay rendered through scrolling multiple sections (no blank-out)', async ({
		page,
	}) => {
		// Multi-section seed: several months, each more than one demand page.
		resetData();
		seedMediaInBuckets([
			{ createdAt: Date.UTC(2024, 4, 15, 12), count: 130 },
			{ createdAt: Date.UTC(2024, 3, 15, 12), count: 130 },
			{ createdAt: Date.UTC(2024, 2, 15, 12), count: 130 },
		]);
		await page.goto('/gallery');
		await expect(page.locator(REAL).first()).toBeVisible();

		const tiles = page.locator(TILE);
		for (let step = 0; step < 12; step++) {
			await page.evaluate((sel) => {
				const el = document.querySelector<HTMLElement>(sel);
				if (el) el.scrollTop = Math.min(el.scrollTop + el.clientHeight * 0.9, el.scrollHeight);
			}, LOADED);
			await page.waitForTimeout(180);
			expect(await tiles.count(), `grid blanked at step ${step}`).toBeGreaterThan(0);
		}
	});

	test('a failed delete surfaces its own error and leaves the item in place', async ({ page }) => {
		await page.route('**/api/media/*', async (route) => {
			if (route.request().method() === 'DELETE') {
				await route.fulfill({ status: 500, contentType: 'text/plain', body: 'boom' });
			} else {
				await route.continue();
			}
		});

		await page.goto('/gallery');
		await expect(page.locator(REAL).first()).toBeVisible();
		await expect(page.locator(LOADED)).toHaveAttribute('data-loaded-count', String(SEED_COUNT));

		await page.locator(TILE).first().hover();
		await page.getByRole('button', { name: 'Delete this media' }).first().click();
		await page
			.getByRole('alertdialog')
			.getByRole('button', { name: 'Delete', exact: true })
			.click();

		await expect(page.getByText('Server returned 500')).toBeVisible();
		// A delete failure is its own channel — no "Retry" button (that belongs to
		// load failures; there's nothing for a reload to re-attempt here).
		await expect(page.getByRole('button', { name: 'Retry' })).toHaveCount(0);
		// Delete failed → no reload happened → the full set is still reserved.
		await expect(page.locator(LOADED)).toHaveAttribute('data-loaded-count', String(SEED_COUNT));
	});
});
