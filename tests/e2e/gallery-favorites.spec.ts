import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test, expect } from './fixtures/test';
import { resetData, seedMediaPrompts } from './helpers';

/**
 * Gallery favorites, end to end: star from the lightbox, see the tile badge, and
 * filter the browse view down to what's starred.
 *
 * Worth an e2e rather than leaving this to the unit + component layers, because
 * the interesting part is exactly the seam they each miss: the gallery is assembled
 * from several independent reads (layout, units, unit-members, and the
 * page load's search + facets) which must all agree on the filter, served through
 * two server-side memos whose keys and fingerprint must account for a star. A
 * real browser against a real server is the only place a disagreement between them
 * shows up — and one did: the drill-in read was the one client call that never sent
 * the filter, which the drilled-in stack test covers. Any new filtered read belongs here
 * too; a server-side test cannot catch a caller that simply doesn't ask.
 *
 * Clean slate + fresh seed per test (one shared DB across projects — see
 * helpers.resetData).
 */

// Scoped to the grid: the open lightbox renders its own /api/media/ image, so an
// unscoped selector counts it as a tile and quietly inflates every assertion made
// with the lightbox open.
const TILE = 'li[data-tile] img[src*="/api/media/"]';
const STAR_BADGE = 'li[data-tile] [title="Favorite"]';

/** Toggle the Favorites filter. It sits in the toolbar at every width (icon-only
 *  on mobile, named by aria-label), so no popover is involved.
 *
 *  `exact` matters: role-name matching is substring-based, and a favorited stack
 *  card's accessible name ends in "N favorites", so a loose "Favorites" would
 *  match the grid as well as this toggle. */
/** Give seeded rows a source model and, optionally, a star — straight to the
 *  DB the webServer reads (helpers.seedMediaPrompts sets neither). */
function setMediaModels(rows: Array<{ id: string; model: string; favorite: boolean }>): void {
	const db = new DatabaseSync(resolve('./tests/.e2e-data/test.db'));
	db.exec('PRAGMA busy_timeout = 5000');
	try {
		const stmt = db.prepare('UPDATE media SET source_model = ?, favorited_at = ? WHERE id = ?');
		for (const r of rows) stmt.run(r.model, r.favorite ? 1_700_000_000_000 : null, r.id);
	} finally {
		db.close();
	}
}

async function toggleFavoritesFilter(page: import('@playwright/test').Page): Promise<void> {
	await page.getByRole('button', { name: 'Favorites', exact: true }).click();
}

test.beforeEach(() => {
	resetData();
	seedMediaPrompts(['a sunset over the ocean', 'a fluffy cat on a sofa', 'a sunset city skyline']);
});

test.describe('gallery: favorites', () => {
	test('starring in the lightbox badges the tile and drives the filter', async ({ page }) => {
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
		await expect(page.getByRole('button', { name: 'Favorites', exact: true })).toHaveAttribute(
			'aria-pressed',
			'false',
		);
		await toggleFavoritesFilter(page);
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

	test('a drilled-in stack shows the same members its card counted', async ({ page }) => {
		// The drill-in is a SIXTH read (/api/media/unit-members) with its own params,
		// and it is the one the other tests never touch: they star solos, so no stack
		// is ever built. Worse, the case that breaks hardest needs the stack's NEWEST
		// member left unstarred — a prompt run is keyed off whichever member leads the
		// stream it was grouped from, so under the filter the key is the newest
		// *starred* member, and a member fetch that drops the filter looks for a key
		// that doesn't exist in the unfiltered grouping and finds nothing at all.
		resetData();
		// Three rows sharing one prompt (and no originalPrompt) land within the orphan
		// gap, so they stack as a single prompt run, newest first. The fourth row is
		// not decoration: the server's gallery memo is validated by a fingerprint of
		// the user's row COUNTS, so re-seeding the same number of rows this file's
		// other tests seed reproduces their exact fingerprint and the stale cached
		// units get served — this test saw three unstacked solos until the count
		// differed. Keep any re-seed in a gallery spec at a row count no sibling test
		// uses.
		seedMediaPrompts(['a heron at dawn', 'a heron at dawn', 'a heron at dawn', 'a lone pine']);
		await page.goto('/gallery');

		const stack = page.getByRole('button', { name: /^Open stack: .*\(3 items\)$/ });
		await expect(stack).toBeVisible();
		await stack.click();
		await expect(page.locator(TILE)).toHaveCount(3);

		// Star the two OLDEST members, leaving the run's leader unstarred.
		for (const nth of [1, 2]) {
			await page.locator(TILE).nth(nth).click();
			await page.getByRole('button', { name: 'Add to favorites' }).click();
			await expect(page.getByRole('button', { name: 'Remove from favorites' })).toBeVisible();
			await page.getByRole('button', { name: 'Close', exact: true }).click();
		}
		await page.getByRole('button', { name: 'Back to gallery' }).click();

		await toggleFavoritesFilter(page);
		// The card re-forms from the starred subset only.
		// The count of starred members is spoken in the card's own accessible name —
		// the star badge is aria-hidden decoration, so this is the only way a screen
		// reader learns the tile is favorited.
		const favStack = page.getByRole('button', { name: /^Open stack: .*\(2 items, 2 favorites\)$/ });
		await expect(favStack).toBeVisible();
		await favStack.click();

		// The members must be exactly what the card promised — not an empty view, and
		// not the unfiltered bucket of three.
		await expect(page.locator(TILE)).toHaveCount(2);
		await expect(page.locator(STAR_BADGE)).toHaveCount(2);
	});

	test('re-starring inside the filter puts the item back on the grid', async ({ page }) => {
		// The undo path. Unstarring while filtered drops the tile, which leaves the
		// lightbox open on an item that is no longer in the grid behind it — so the
		// star is right there to click again, and that has to restore the tile rather
		// than leave the row starred on the server but missing until a reload.
		await page.goto('/gallery');
		await page.locator(TILE).first().click();
		await page.getByRole('button', { name: 'Add to favorites' }).click();
		await expect(page.getByRole('button', { name: 'Remove from favorites' })).toBeVisible();
		await page.getByRole('button', { name: 'Close', exact: true }).click();

		await toggleFavoritesFilter(page);
		await expect(page.locator(TILE)).toHaveCount(1);

		await page.locator(TILE).first().click();
		await page.getByRole('button', { name: 'Remove from favorites' }).click();
		await expect(page.getByRole('button', { name: 'Add to favorites' })).toBeVisible();
		// Gone from the filtered grid...
		await expect(page.locator(TILE)).toHaveCount(0);

		// ...and back again, without closing the lightbox or reloading the page.
		await page.getByRole('button', { name: 'Add to favorites' }).click();
		await expect(page.getByRole('button', { name: 'Remove from favorites' })).toBeVisible();
		await page.getByRole('button', { name: 'Close', exact: true }).click();
		await expect(page.locator(TILE)).toHaveCount(1);
		await expect(page.locator(STAR_BADGE)).toHaveCount(1);
	});

	test('unstarring inside a filtered search drops the row and its count', async ({ page }) => {
		// Search renders its own ranked list, not the browse feed, so the filtered
		// browse reseed can't fix it: the row would sit there with an empty star and
		// a stale "N results" while the same action in browse removes the tile.
		await page.goto('/gallery');
		for (const nth of [0, 2]) {
			await page.locator(TILE).nth(nth).click();
			await page.getByRole('button', { name: 'Add to favorites' }).click();
			await expect(page.getByRole('button', { name: 'Remove from favorites' })).toBeVisible();
			await page.getByRole('button', { name: 'Close', exact: true }).click();
		}

		await toggleFavoritesFilter(page);
		await page.getByRole('button', { name: 'Search prompts' }).click();
		await page.getByRole('searchbox', { name: 'Search prompts' }).fill('sunset');
		await expect(page.getByText('2 results for "sunset"')).toBeVisible();

		await page.locator(TILE).first().click();
		await page.getByRole('button', { name: 'Remove from favorites' }).click();
		await expect(page.getByRole('button', { name: 'Add to favorites' })).toBeVisible();
		await page.getByRole('button', { name: 'Close', exact: true }).click();

		// The row left the filtered result set, and the count says so.
		await expect(page.getByText('1 result for "sunset"')).toBeVisible();
		await expect(page.locator(TILE)).toHaveCount(1);
	});

	test('composes with prompt search instead of replacing it', async ({ page }) => {
		await page.goto('/gallery');
		await expect(page.locator(TILE)).toHaveCount(3);

		// Star only the newest item ("a sunset over the ocean"). The seed holds a
		// SECOND sunset that stays unstarred, which is what makes the last assertion
		// below able to tell the filter apart from the query.
		await page.locator(TILE).first().click();
		await page.getByRole('button', { name: 'Add to favorites' }).click();
		await expect(page.getByRole('button', { name: 'Remove from favorites' })).toBeVisible();
		await page.getByRole('button', { name: 'Close', exact: true }).click();

		await toggleFavoritesFilter(page);
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
		await toggleFavoritesFilter(page);
		await expect(page.getByText('2 results for "sunset"')).toBeVisible();
		await expect(page.locator(TILE)).toHaveCount(2);
	});

	test("unstarring a model's only favorite drops it from the Model filter", async ({ page }) => {
		// The Model dropdown's counts come from the page load and are narrowed by the
		// Favorites filter, so a toggle that empties a model's filtered set has to
		// re-read them, or the dropdown offers a model that leads to an empty grid.
		// Five rows: the memo fingerprint is keyed on row counts, and sibling tests
		// seed three and four (see the drilled-in stack test).
		resetData();
		seedMediaPrompts([
			'a red kite',
			'a blue whale',
			'a green field',
			'a grey cloud',
			'a gold coin',
		]);
		setMediaModels([
			{ id: 'e2e-media-0000', model: 'model-a', favorite: true },
			{ id: 'e2e-media-0001', model: 'model-b', favorite: true },
			{ id: 'e2e-media-0002', model: 'model-c', favorite: true },
		]);
		await page.goto('/gallery?fav=1');
		await expect(page.locator(TILE)).toHaveCount(3);
		// Inline on desktop, CSS-hidden on mobile — present in the DOM either way.
		const option = (model: string) =>
			page.locator(`select[aria-label="Filter by model"] option[value="${model}"]`).first();
		await expect(option('model-b')).toHaveCount(1);

		let layoutFetches = 0;
		page.on('request', (r) => {
			if (new URL(r.url()).pathname === '/api/media/layout') layoutFetches++;
		});

		await page.locator('li[data-tile] img[src*="e2e-media-0001"]').click();
		await page.getByRole('button', { name: 'Remove from favorites' }).click();
		await expect(page.getByRole('button', { name: 'Add to favorites' })).toBeVisible();
		await page.getByRole('button', { name: 'Close', exact: true }).click();

		await expect(page.locator(TILE)).toHaveCount(2);
		await expect(option('model-b')).toHaveCount(0);
		await expect(option('model-a')).toHaveCount(1);
		// The re-read must not reseed the feed a second time: the reload effect keys on
		// the filters, which the toggle didn't change.
		await page.waitForLoadState('networkidle');
		expect(layoutFetches).toBe(1);
	});
});
