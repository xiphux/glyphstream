import { test, expect, type Page } from './fixtures/test';
import { resetData, seedMedia } from './helpers';

/**
 * The gallery must not reload, or lose its place, just because the app came
 * back into focus.
 *
 * The (app) layout refreshes its data on focus / visibility / pageshow. The
 * gallery's page load waits on the layout, so its `data` is replaced with
 * identical filters; the browse feed used to treat that as a filter change,
 * refetch layout + units and jump to the top. The same thing happened once on
 * every cold load, when the layout's deferred refetch landed.
 */

const SCROLLER = '[data-loaded-count]';

function countBrowseRequests(page: Page): { layout: number; units: number } {
	const counts = { layout: 0, units: 0 };
	page.on('request', (r) => {
		const path = new URL(r.url()).pathname;
		if (path === '/api/media/layout') counts.layout++;
		if (path === '/api/media/units') counts.units++;
	});
	return counts;
}

test.beforeEach(() => {
	resetData();
	seedMedia(150);
});
test.skip(({ isMobile }) => isMobile, 'same code path on mobile; one viewport is enough');

test('a cold load fetches the browse feed once', async ({ page }) => {
	const counts = countBrowseRequests(page);
	await page.goto('/gallery');
	await expect(page.locator(SCROLLER)).toHaveAttribute('data-loaded-count', '150');
	// Let the layout's deferred refetch land.
	await page.waitForLoadState('networkidle');
	expect(counts.layout).toBe(1);
});

test('coming back to the app keeps the scroll position and does not refetch', async ({ page }) => {
	await page.goto('/gallery');
	await expect(page.locator(SCROLLER)).toHaveAttribute('data-loaded-count', '150');
	await page.waitForLoadState('networkidle');

	await page.evaluate((sel) => {
		const el = document.querySelector<HTMLElement>(sel)!;
		el.scrollTop = el.scrollHeight / 2;
	}, SCROLLER);
	const before = await page.evaluate(
		(sel) => document.querySelector<HTMLElement>(sel)!.scrollTop,
		SCROLLER,
	);
	expect(before).toBeGreaterThan(0);

	const counts = countBrowseRequests(page);
	const layoutRefresh = page.waitForResponse((r) => r.url().includes('__data.json'));
	// What the layout listens for when the window regains focus.
	await page.evaluate(() => window.dispatchEvent(new Event('focus')));
	await layoutRefresh;
	await page.waitForLoadState('networkidle');

	expect(counts).toEqual({ layout: 0, units: 0 });
	const after = await page.evaluate(
		(sel) => document.querySelector<HTMLElement>(sel)!.scrollTop,
		SCROLLER,
	);
	expect(after).toBe(before);
});

test('changing a filter still reloads the feed', async ({ page }) => {
	await page.goto('/gallery');
	await expect(page.locator(SCROLLER)).toHaveAttribute('data-loaded-count', '150');
	await page.waitForLoadState('networkidle');

	const counts = countBrowseRequests(page);
	await page.getByRole('button', { name: 'Videos', exact: true }).first().click();
	await expect.poll(() => counts.layout).toBe(1);
});
