import { test, expect } from '@playwright/test';
import { resetData, seedMediaInBuckets } from './helpers';

/**
 * Gallery date grouping + quick-jump timeline rail. This behaviour is painful
 * to reproduce by hand — it needs media spread across many months — so we seed
 * dated rows straight into the DB (no bytes; the grid only needs the heading +
 * <img> DOM nodes) and drive the real headers / rail / seek.
 *
 * Dates are mid-month noon UTC and well in the past, so local-timezone
 * bucketing can't shift the month and the relative "Today"/"Yesterday" day
 * labels never apply — keeping label assertions stable on any CI clock/tz.
 *
 * Clean slate + fresh seed per test (one shared DB across projects — see
 * helpers.resetData).
 */

const MAR_2024 = Date.UTC(2024, 2, 15, 12); // March 2024
const MAR_2024_EARLIER = Date.UTC(2024, 2, 10, 12); // March 10 2024
const FEB_2024 = Date.UTC(2024, 1, 15, 12); // February 2024
const DEC_2023 = Date.UTC(2023, 11, 15, 12); // December 2023

const TILE = 'img[src*="/api/media/"]';

test.describe('gallery: date grouping + timeline rail', () => {
	test('renders month headers and a per-month rail across months', async ({ page }) => {
		resetData();
		seedMediaInBuckets([
			{ createdAt: MAR_2024, count: 3 },
			{ createdAt: FEB_2024, count: 3 },
			{ createdAt: DEC_2023, count: 3 },
		]);
		await page.goto('/gallery');

		// Default (month) granularity → one sticky header per month.
		await expect(page.getByRole('heading', { name: 'March 2024' })).toBeVisible();
		await expect(page.getByRole('heading', { name: 'February 2024' })).toBeVisible();
		await expect(page.getByRole('heading', { name: 'December 2023' })).toBeVisible();

		// One rail tick per month (the oldest is the clearest unique target).
		await expect(page.getByRole('button', { name: 'Jump to December 2023' })).toBeVisible();
	});

	test('Day granularity splits a month into per-day headers', async ({ page }) => {
		resetData();
		seedMediaInBuckets([
			{ createdAt: MAR_2024, count: 2 },
			{ createdAt: MAR_2024_EARLIER, count: 2 },
		]);
		await page.goto('/gallery');

		// Month view collapses both days into one header.
		await expect(page.getByRole('heading', { name: 'March 2024' })).toBeVisible();

		await page.getByRole('button', { name: 'Day', exact: true }).click();

		// Now two distinct day headers, and the month header is gone.
		await expect(page.getByRole('heading', { name: 'March 2024' })).toHaveCount(0);
		await expect(page.getByRole('heading', { name: /March 15, 2024/ })).toBeVisible();
		await expect(page.getByRole('heading', { name: /March 10, 2024/ })).toBeVisible();
	});

	test('quick-jump seeks to a month that is not yet loaded', async ({ page }) => {
		resetData();
		// 70 + 70 fill past the first SSR page (60), so the 5 December rows are not
		// loaded initially — reaching them requires the rail to seek, not scroll.
		seedMediaInBuckets([
			{ createdAt: MAR_2024, count: 70 },
			{ createdAt: FEB_2024, count: 70 },
			{ createdAt: DEC_2023, count: 5 },
		]);
		await page.goto('/gallery');

		await expect(page.locator(TILE)).toHaveCount(60); // first page = newest month
		await expect(page.getByRole('heading', { name: 'December 2023' })).toHaveCount(0);

		// Jump to the off-screen month → the feed re-anchors there (O(1) seek).
		await page.getByRole('button', { name: 'Jump to December 2023' }).click();
		await expect(page.getByRole('heading', { name: 'December 2023' })).toBeVisible();
		// Re-anchored: the newest month is no longer in the feed.
		await expect(page.getByRole('heading', { name: 'March 2024' })).toHaveCount(0);

		// The newest tick returns to the top of history.
		await page.getByRole('button', { name: 'Jump to March 2024' }).click();
		await expect(page.getByRole('heading', { name: 'March 2024' })).toBeVisible();
	});
});
