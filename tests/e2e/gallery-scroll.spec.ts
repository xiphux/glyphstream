import { test, expect } from '@playwright/test';
import { resetData, seedMedia } from './helpers';

/**
 * Gallery infinite-scroll. The grid SSRs the first page (60 rows) and then
 * auto-loads each subsequent page as an IntersectionObserver sentinel nears
 * the bottom of the scroll viewport — there is no longer a manual "Load
 * more" button. These specs seed more rows than fit on one page (so several
 * loads must chain) and assert the grid grows on scroll alone.
 *
 * Clean slate + fresh seed per test for the usual one-DB-across-projects
 * reason (see helpers.resetData): a sibling test's media would skew the
 * deterministic tile counts here.
 *
 * SEED_COUNT = 150 spans exactly three pages (60 + 60 + 30); the final page
 * is short, so the server returns a null nextCursor and the sentinel
 * unmounts — letting us assert the grid settles at exactly 150 and grows no
 * further.
 */

const PAGE_SIZE = 60;
const SEED_COUNT = 150;

// Every gallery tile is an <img> pointing at the per-id thumbnail route.
// Counting these DOM nodes is load-independent: the seeded rows have no
// bytes on disk, so the thumbnails 404 — but the <img> element still exists,
// which is all the count needs.
const TILE_SELECTOR = 'img[src*="/api/media/"]';

test.beforeEach(() => {
	resetData();
	seedMedia(SEED_COUNT);
});

test.describe('gallery: infinite scroll', () => {
	test('SSRs the first page and has no "Load more" button', async ({ page }) => {
		await page.goto('/gallery');
		await expect(page.getByRole('heading', { name: 'Gallery' })).toBeVisible();

		// Exactly one page rendered up front…
		await expect(page.locator(TILE_SELECTOR)).toHaveCount(PAGE_SIZE);
		// …and the old manual control is gone for good.
		await expect(page.getByRole('button', { name: 'Load more' })).toHaveCount(0);
	});

	test('auto-loads further pages as you scroll to the bottom', async ({ page }) => {
		await page.goto('/gallery');
		const tiles = page.locator(TILE_SELECTOR);
		await expect(tiles).toHaveCount(PAGE_SIZE);

		// Scrolling the last tile into view drags the sentinel into its 400px
		// prefetch zone, which fires the auto-load. Re-scrolling on each poll
		// chains through every page: as new tiles append, `.last()` is a new,
		// lower element, so the next scroll pushes the sentinel down again.
		// We assert it climbs PAST a single extra page rather than to an exact
		// number first, to prove the chaining works at all before pinning the
		// final total.
		await expect
			.poll(
				async () => {
					await tiles.last().scrollIntoViewIfNeeded();
					return tiles.count();
				},
				{ timeout: 15_000 },
			)
			.toBeGreaterThan(PAGE_SIZE);
	});

	test('settles at the full set and stops loading on the last page', async ({ page }) => {
		await page.goto('/gallery');
		const tiles = page.locator(TILE_SELECTOR);
		await expect(tiles).toHaveCount(PAGE_SIZE);

		// Drive it all the way to the end.
		await expect
			.poll(
				async () => {
					await tiles.last().scrollIntoViewIfNeeded();
					return tiles.count();
				},
				{ timeout: 20_000 },
			)
			.toBe(SEED_COUNT);

		// On the last (short) page the server returns nextCursor=null, so the
		// sentinel unmounts and no further fetch can fire. One more scroll +
		// settle must leave the count pinned at the full set — a guard against
		// a regression that re-requested the final page or looped past the end.
		await tiles.last().scrollIntoViewIfNeeded();
		await page.waitForTimeout(500);
		await expect(tiles).toHaveCount(SEED_COUNT);
	});

	test('a failed delete shows its own error and does NOT block infinite scroll', async ({
		page,
	}) => {
		// Force every media DELETE to fail server-side. The glob only matches
		// the single-segment delete route (`/api/media/<id>`); the paginating
		// GET (`/api/media?cursor=…`) and the thumbnail route
		// (`/api/media/<id>/thumbnail`) have a different shape and pass through,
		// so scrolling still hits the real server.
		await page.route('**/api/media/*', async (route) => {
			if (route.request().method() === 'DELETE') {
				await route.fulfill({ status: 500, contentType: 'text/plain', body: 'boom' });
			} else {
				await route.continue();
			}
		});

		await page.goto('/gallery');
		const tiles = page.locator(TILE_SELECTOR);
		await expect(tiles).toHaveCount(PAGE_SIZE);

		// Delete the first tile and confirm — the request 500s.
		await page.getByRole('button', { name: 'Delete this media' }).first().click();
		await page
			.getByRole('alertdialog')
			.getByRole('button', { name: 'Delete', exact: true })
			.click();

		// The delete failure surfaces its own banner, carries NO Retry button
		// (Retry belongs to pagination only), and leaves the tile in place
		// (optimistic removal happens only on success).
		await expect(page.getByText('Server returned 500')).toBeVisible();
		await expect(page.getByRole('button', { name: 'Retry' })).toHaveCount(0);
		await expect(tiles).toHaveCount(PAGE_SIZE);

		// The actual regression guard for reviewer issue #1: a delete error now
		// lives in a channel separate from pagination, so scrolling to the
		// bottom must still auto-load the next page.
		await expect
			.poll(
				async () => {
					await tiles.last().scrollIntoViewIfNeeded();
					return tiles.count();
				},
				{ timeout: 15_000 },
			)
			.toBeGreaterThan(PAGE_SIZE);
	});
});
