import { test, expect } from '@playwright/test';
import { resetData, seedMediaPrompts } from './helpers';

/**
 * Gallery prompt search (keyword leg). Seeds media with known prompts straight
 * into the DB (no bytes; the FTS triggers index `prompt_full` on insert) and
 * drives the real search box: a relevance-ranked mode that hides the
 * chronological chrome (date/Stack toggles, timeline rail) while active.
 *
 * Clean slate + fresh seed per test (one shared DB across projects — see
 * helpers.resetData).
 */

const TILE = 'img[src*="/api/media/"]';

test.beforeEach(() => {
	resetData();
	seedMediaPrompts(['a sunset over the ocean', 'a fluffy cat on a sofa', 'a sunset city skyline']);
});

test.describe('gallery: prompt search', () => {
	test('narrows to prompt matches and restores on clear', async ({ page }) => {
		await page.goto('/gallery');
		await expect(page.locator(TILE)).toHaveCount(3);

		// Search is collapsed to an icon until clicked, then expands into the box.
		await page.getByRole('button', { name: 'Search prompts' }).click();
		const box = page.getByRole('searchbox', { name: 'Search prompts' });
		await box.fill('sunset');

		// Two of the three prompts contain "sunset".
		await expect(page.locator(TILE)).toHaveCount(2);
		await expect(page.getByText('2 results for "sunset"')).toBeVisible();

		// A different term narrows further.
		await box.fill('cat');
		await expect(page.locator(TILE)).toHaveCount(1);

		// Clearing restores the full chronological browse.
		await page.getByRole('button', { name: 'Clear search' }).click();
		await expect(page.locator(TILE)).toHaveCount(3);
	});

	test('hides the chronological chrome while searching', async ({ page, isMobile }) => {
		await page.goto('/gallery');
		// The View options control is present in the normal browse…
		await expect(page.getByRole('button', { name: 'View options' })).toBeVisible();

		await page.getByRole('button', { name: 'Search prompts' }).click();
		await page.getByRole('searchbox', { name: 'Search prompts' }).fill('sunset');
		await expect(page.getByText('2 results for "sunset"')).toBeVisible();

		// …and the chronological view prefs (Stack + Day/Month) are gone in ranked
		// search. On desktop the filters are inline, so the view-only popover
		// disappears entirely; on mobile the popover persists to host the filters
		// (which compose with search), but its view section is gone — open it and
		// confirm Stack/Month are absent.
		if (isMobile) {
			await page.getByRole('button', { name: 'View options' }).click();
			await expect(page.getByRole('switch', { name: 'Stack' })).toHaveCount(0);
			await expect(page.getByRole('button', { name: 'Month', exact: true })).toHaveCount(0);
		} else {
			await expect(page.getByRole('button', { name: 'View options' })).toHaveCount(0);
		}
	});

	test('shows an empty state for a no-match query', async ({ page }) => {
		await page.goto('/gallery');
		await page.getByRole('button', { name: 'Search prompts' }).click();
		await page.getByRole('searchbox', { name: 'Search prompts' }).fill('zzzznomatch');
		await expect(page.getByText('No results for "zzzznomatch".')).toBeVisible();
		await expect(page.locator(TILE)).toHaveCount(0);
	});
});
