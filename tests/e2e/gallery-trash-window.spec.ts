import { test, expect } from './fixtures/test';
import { resetData, seedMedia, trashAllMedia } from './helpers';

/**
 * The trash page draws its grid a page at a time: up to a thousand items can
 * be waiting there, and every tile used to be rendered and built up front.
 * Scrolling must still reach all of them.
 */

const TILES = 'main ul > li';

test.beforeEach(() => {
	resetData();
	seedMedia(300);
	trashAllMedia();
});
test.skip(({ isMobile }) => isMobile, 'same code path on mobile; one viewport is enough');

test('renders the first page, then the rest as you scroll', async ({ page }) => {
	await page.goto('/gallery/trash');
	await expect(page.locator(TILES)).toHaveCount(120);
	for (let i = 0; i < 10; i++) {
		await page.locator(TILES).last().scrollIntoViewIfNeeded();
		if ((await page.locator(TILES).count()) === 300) break;
	}
	await expect(page.locator(TILES)).toHaveCount(300);
});
