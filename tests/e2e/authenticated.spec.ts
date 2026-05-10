import { test, expect } from '@playwright/test';

/**
 * Smoke tests that verify the authenticated app surface renders without
 * needing a working upstream model server. The fixtures/config.toml ships
 * an empty endpoints list — model picker shows its empty state, but
 * routes/sidebar/forms still work and that's what we're testing.
 */

test.describe('authenticated app shell', () => {
	test('new-chat home renders the greeting + composer', async ({ page }) => {
		await page.goto('/');
		// Greeting is "{Greeting}, {firstName}". firstName is "E2E"
		// (split of displayName "E2E Tester").
		await expect(page.getByRole('heading', { level: 1 })).toContainText('E2E');
		await expect(page.locator('textarea')).toBeVisible();
	});

	test('sidebar shows nav items + recents subheader', async ({ page, isMobile }) => {
		await page.goto('/');
		// Mobile starts with the sidebar collapsed behind the hamburger.
		if (isMobile) {
			await page.getByRole('button', { name: 'Open menu' }).click();
		}
		await expect(page.getByRole('link', { name: /^New chat$/ })).toBeVisible();
		await expect(page.getByRole('link', { name: /^Gallery$/ })).toBeVisible();
		await expect(page.getByRole('link', { name: /^Custom models$/ })).toBeVisible();
		await expect(page.getByRole('link', { name: /^Archived$/ })).toBeVisible();
		await expect(page.getByText('Recents')).toBeVisible();
	});

	test('archived page renders empty state', async ({ page, isMobile }) => {
		await page.goto('/');
		if (isMobile) {
			await page.getByRole('button', { name: 'Open menu' }).click();
		}
		await page.getByRole('link', { name: /^Archived$/ }).click();
		await expect(page).toHaveURL(/\/archived$/);
		await expect(page.getByRole('heading', { name: /archived conversations/i })).toBeVisible();
		await expect(page.getByText(/no archived conversations/i)).toBeVisible();
	});

	test('gallery page renders empty state + filter pills', async ({ page }) => {
		await page.goto('/gallery');
		await expect(page.getByRole('heading', { name: 'Gallery' })).toBeVisible();
		await expect(page.getByText(/no media yet/i)).toBeVisible();
		// Filter pills are present (clickable behavior is exercised via the
		// unit tests on listMediaForUser; here we just want the UI surface).
		await expect(page.getByRole('button', { name: 'All' })).toBeVisible();
		await expect(page.getByRole('button', { name: 'Images' })).toBeVisible();
		await expect(page.getByRole('button', { name: 'Videos' })).toBeVisible();
	});

	test('custom models settings page renders the form', async ({ page, isMobile }) => {
		await page.goto('/settings/models');
		await expect(page.getByRole('heading', { name: 'Custom models' })).toBeVisible();
		await expect(page.getByText(/none yet/i)).toBeVisible();
		// Form fields.
		await expect(page.getByLabel('Name')).toBeVisible();
		await expect(page.getByLabel(/^Description/)).toBeVisible();
		// Submit button is disabled while name + base model are empty.
		const submit = page.getByRole('button', { name: 'Create preset' });
		await expect(submit).toBeDisabled();
		void isMobile;
	});

	test('sidebar collapse toggle persists state to localStorage', async ({
		page,
		isMobile
	}) => {
		// Collapse only applies at sm+ — skip on mobile (drawer pattern).
		test.skip(isMobile, 'Collapse toggle is desktop-only');
		await page.goto('/');
		// Wait for hydration to complete — the toggle's click handler is wired
		// in client-side JS, and we hit a race when clicking before the
		// hydration onclick is attached otherwise.
		await page.waitForLoadState('networkidle');

		const toggle = page.getByRole('button', { name: 'Collapse sidebar' });
		await expect(toggle).toBeVisible();

		// Dispatch via DOM directly so we don't fight Playwright's
		// element-stability heuristics on a small icon button.
		await toggle.evaluate((el: HTMLButtonElement) => el.click());

		await expect
			.poll(() =>
				page.evaluate(() =>
					window.localStorage.getItem('glyphstream:sidebarCollapsed')
				)
			)
			.toBe('1');
	});

	test('mobile drawer opens via hamburger', async ({ page, isMobile }) => {
		test.skip(!isMobile, 'Drawer is mobile-only');
		await page.goto('/');
		await page.waitForLoadState('networkidle');

		const galleryLink = page.getByRole('link', { name: 'Gallery' });
		// Drawer rendered but transformed off-screen.
		await expect(galleryLink).not.toBeInViewport();

		// Dispatch click directly so the drawer-open handler fires reliably.
		await page
			.getByRole('button', { name: 'Open menu' })
			.evaluate((el: HTMLButtonElement) => el.click());

		await expect(galleryLink).toBeInViewport();
	});

	test('app shows "no models available" when endpoints list is empty', async ({ page }) => {
		await page.goto('/');
		// Our fixture config.toml has zero endpoints; the picker should
		// show the explanatory note rather than crashing.
		await expect(page.getByText(/no models available/i)).toBeVisible();
	});
});

test.describe('unauthenticated', () => {
	test('logged-out request to / redirects to /login', async ({ browser }) => {
		// Fresh context with no storage state — overrides the per-test
		// pre-authenticated state from the config.
		const ctx = await browser.newContext({ storageState: { cookies: [], origins: [] } });
		const page = await ctx.newPage();
		await page.goto('/');
		await expect(page).toHaveURL(/\/login/);
		await expect(page.getByRole('link', { name: /Sign in with GitHub/i })).toBeVisible();
		await ctx.close();
	});
});
