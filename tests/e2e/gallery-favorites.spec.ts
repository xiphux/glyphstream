import { test, expect } from './fixtures/test';
import { resetData, seedMediaPrompts } from './helpers';

/**
 * Gallery favorites, end to end: star from the lightbox, see the tile badge, and
 * filter the browse view down to what's starred.
 *
 * Worth an e2e rather than leaving this to the unit + component layers, because
 * the interesting part is exactly the seam they each miss. The browse grid is
 * assembled from FIVE separate reads (layout, units, unit-members, periods, and
 * the page load's facets) which must agree on the filter, and it's served through
 * two server-side memos whose keys and fingerprint had to learn about a star. A
 * real browser against a real server is the only place a disagreement between
 * them shows up.
 *
 * Clean slate + fresh seed per test (one shared DB across projects — see
 * helpers.resetData).
 */

// Scoped to the grid: the open lightbox renders its own /api/media/ image, so an
// unscoped selector counts it as a tile and quietly inflates every assertion made
// with the lightbox open.
const TILE = 'li[data-tile] img[src*="/api/media/"]';
const STAR_BADGE = 'li[data-tile] [title="Favorite"]';

/** Toggle the Favorites filter, reaching it through the View options popover on
 *  mobile — and dismissing that popover afterwards, since it survives the
 *  filter's navigation and would swallow the next click. */
async function toggleFavoritesFilter(
	page: import('@playwright/test').Page,
	isMobile: boolean,
): Promise<void> {
	if (isMobile) await page.getByRole('button', { name: 'View options' }).click();
	await page.getByRole('button', { name: 'Favorites' }).click();
	if (isMobile) await page.keyboard.press('Escape');
}

test.beforeEach(() => {
	resetData();
	seedMediaPrompts(['a sunset over the ocean', 'a fluffy cat on a sofa', 'a sunset city skyline']);
});

test.describe('gallery: favorites', () => {
	test('starring in the lightbox badges the tile and drives the filter', async ({
		page,
		isMobile,
	}) => {
		await page.goto('/gallery');
		await expect(page.locator(TILE)).toHaveCount(3);
		await expect(page.locator(STAR_BADGE)).toHaveCount(0);

		// Open the newest tile's lightbox and star it.
		await page.locator(TILE).first().click();
		const star = page.getByRole('button', { name: 'Add to favorites' });
		await expect(star).toBeVisible();
		await star.click();

		// The button flips in place (the caller owns the optimistic update)...
		await expect(page.getByRole('button', { name: 'Remove from favorites' })).toBeVisible();
		await page.getByRole('button', { name: 'Close', exact: true }).click();

		// ...and the tile behind it now carries the badge, without a grid reload.
		await expect(page.locator(STAR_BADGE)).toHaveCount(1);

		// Filtering narrows the whole browse view to the starred item. The toggle
		// keeps one accessible name and reports its state through aria-pressed.
		if (isMobile) await page.getByRole('button', { name: 'View options' }).click();
		await expect(page.getByRole('button', { name: 'Favorites' })).toHaveAttribute(
			'aria-pressed',
			'false',
		);
		if (isMobile) await page.keyboard.press('Escape');
		await toggleFavoritesFilter(page, isMobile);
		await expect(page.locator(TILE)).toHaveCount(1);

		// The filter is in the URL, so it survives a reload — and the reloaded page
		// is served from the server's memos rather than the optimistic local state,
		// which is what proves the star persisted and both cache keys carry the flag.
		await page.reload();
		await expect(page.locator(TILE)).toHaveCount(1);
		await expect(page.locator(STAR_BADGE)).toHaveCount(1);

		// Unstarring from inside the filtered view has to remove the item from the
		// grid, not just unfill the star — the one case the local patch can't express.
		await page.locator(TILE).first().click();
		await page.getByRole('button', { name: 'Remove from favorites' }).click();
		await expect(page.getByRole('button', { name: 'Add to favorites' })).toBeVisible();
		await page.getByRole('button', { name: 'Close', exact: true }).click();
		await expect(page.locator(TILE)).toHaveCount(0);
	});

	test('composes with prompt search instead of replacing it', async ({ page, isMobile }) => {
		await page.goto('/gallery');
		await expect(page.locator(TILE)).toHaveCount(3);

		// Star only the newest item ("a sunset over the ocean"). The seed holds a
		// SECOND sunset that stays unstarred, which is what makes the last assertion
		// below able to tell the filter apart from the query.
		await page.locator(TILE).first().click();
		await page.getByRole('button', { name: 'Add to favorites' }).click();
		await expect(page.getByRole('button', { name: 'Remove from favorites' })).toBeVisible();
		await page.getByRole('button', { name: 'Close', exact: true }).click();

		await toggleFavoritesFilter(page, isMobile);
		await expect(page.locator(TILE)).toHaveCount(1);

		// Searching inside Favorites ANDs the two: one of the two sunsets is starred.
		// Search is a different server path from browse (ranked, SSR'd, its own
		// query), so this is where a filter threaded through only the browse reads
		// would show up.
		await page.getByRole('button', { name: 'Search prompts' }).click();
		await page.getByRole('searchbox', { name: 'Search prompts' }).fill('sunset');
		await expect(page.getByText('1 result for "sunset"')).toBeVisible();
		await expect(page.locator(TILE)).toHaveCount(1);

		// Dropping the filter widens the SAME query to both sunsets — so the
		// narrowing above was the favorite filter, not the query doing all the work.
		await toggleFavoritesFilter(page, isMobile);
		await expect(page.getByText('2 results for "sunset"')).toBeVisible();
		await expect(page.locator(TILE)).toHaveCount(2);
	});
});
