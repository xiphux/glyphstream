import { test, expect } from '@playwright/test';
import { resetData } from './helpers';

/**
 * Smoke tests that verify the authenticated app surface renders. The
 * fixtures/config.toml points at the mock upstream (a chat + image model),
 * so the picker is populated; the empty-state assertions below rely on a
 * clean DB, which the beforeEach reset guarantees regardless of what other
 * specs (or the other project) created against the shared server.
 */

// Empty-state tests (gallery, archived) need a pristine DB; the flow specs
// create persistent conversations + media against the same webServer, so
// reset to baseline before each test here too.
test.beforeEach(() => resetData());

test.describe('authenticated app shell', () => {
	test('new-chat home renders the greeting + composer', async ({ page }) => {
		await page.goto('/');
		// The greeting is rolled client-side per visit (random line + local
		// time-of-day), and many lines intentionally omit the user's name
		// ("Burning the midnight oil", "Ask me anything", ...), so asserting a
		// specific token here is flaky. Name composition is covered by the pure
		// unit tests in tests/unit/greeting.test.ts; here we only smoke-test
		// that the greeting heading renders.
		const greeting = page.getByRole('heading', { level: 1 });
		await expect(greeting).toBeVisible();
		await expect(greeting).not.toBeEmpty();
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

	// A stale OS notification for a deleted conversation used to land on the
	// bare 404 page, which in a standalone PWA has no way out — no back
	// button, no app chrome. It redirects home with an explanatory toast now.
	test('a missing conversation redirects home with a toast', async ({ page }) => {
		await page.goto('/chat/does-not-exist');
		await expect(page).toHaveURL(/\/$/);
		await expect(page.getByText(/that conversation no longer exists/i)).toBeVisible();
		await expect(page.locator('textarea')).toBeVisible();
		// The notice param is stripped so a refresh doesn't replay the toast.
		expect(new URL(page.url()).searchParams.has('notice')).toBe(false);
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

	test('gallery page renders empty state + filter pills', async ({ page, isMobile }) => {
		await page.goto('/gallery');
		await expect(page.getByRole('heading', { name: 'Gallery' })).toBeVisible();
		await expect(page.getByText(/no media yet/i)).toBeVisible();
		// The kind pills live inline on desktop but collapse into the View
		// options popover on mobile — open it there first. (Clickable behavior is
		// exercised via the unit tests on listMediaForUser; here we just want the
		// UI surface.)
		if (isMobile) {
			await page.getByRole('button', { name: 'View options' }).click();
		}
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

	test('sidebar collapse toggle persists state to localStorage', async ({ page, isMobile }) => {
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
			.poll(() => page.evaluate(() => window.localStorage.getItem('glyphstream:sidebarCollapsed')))
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

	test('model picker is populated from the configured endpoint', async ({ page }) => {
		await page.goto('/');
		// The fixture config points at the mock upstream, which advertises a
		// chat + image model. The "no models available" hint must be absent,
		// and the picker should auto-select the first chat model (Mock Chat).
		await expect(page.getByText(/no models available/i)).toHaveCount(0);
		await expect(page.getByRole('button', { name: 'Select model' })).toContainText('Mock Chat');
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
