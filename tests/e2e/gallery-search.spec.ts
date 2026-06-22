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

	test('hides the chronological chrome while searching', async ({ page }) => {
		await page.goto('/gallery');
		// The Day/Month + Stack toggles are present in the normal browse…
		await expect(page.getByRole('button', { name: 'Month', exact: true })).toBeVisible();

		await page.getByRole('searchbox', { name: 'Search prompts' }).fill('sunset');
		await expect(page.getByText('2 results for "sunset"')).toBeVisible();

		// …and gone in search mode (ranked, not chronological).
		await expect(page.getByRole('button', { name: 'Month', exact: true })).toHaveCount(0);
		await expect(page.getByRole('button', { name: 'Stack', exact: true })).toHaveCount(0);
	});

	test('shows an empty state for a no-match query', async ({ page }) => {
		await page.goto('/gallery');
		await page.getByRole('searchbox', { name: 'Search prompts' }).fill('zzzznomatch');
		await expect(page.getByText('No results for "zzzznomatch".')).toBeVisible();
		await expect(page.locator(TILE)).toHaveCount(0);
	});
});
