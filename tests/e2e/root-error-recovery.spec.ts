import { test, expect } from './fixtures/test';
import { resetData } from './helpers';

/**
 * A background refresh whose `__data.json` fails (the container restarting
 * while the tab is refocused) makes Kit replace the app with the root error
 * page; there is no way to catch it at the call site. The page must come back
 * on its own once the server answers again, without a Reload tap.
 *
 * Runs against the real Kit client because what's under test is that the
 * error page's retry actually re-enters the app tree from Kit's error state.
 */

test.beforeEach(() => {
	resetData();
});
test.skip(({ isMobile }) => isMobile, 'same code path on mobile; one viewport is enough');

test('the app recovers from a failed background refresh by itself', async ({ page }) => {
	await page.goto('/');
	const composer = page.getByPlaceholder('How can I help you today?');
	await expect(composer).toBeVisible();
	await page.waitForLoadState('networkidle');

	await page.route('**/__data.json*', (route) =>
		route.fulfill({ status: 502, contentType: 'text/html', body: '<h1>Bad Gateway</h1>' }),
	);
	// What the (app) layout listens for when the window regains focus.
	await page.evaluate(() => window.dispatchEvent(new Event('focus')));
	await expect(page.getByText('Reconnecting…')).toBeVisible();
	await expect(composer).toHaveCount(0);

	await page.unroute('**/__data.json*');
	await expect(composer).toBeVisible({ timeout: 10_000 });
	await expect(page.getByText('Reconnecting…')).toHaveCount(0);
});
