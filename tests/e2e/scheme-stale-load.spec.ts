import { test, expect, type Page } from './fixtures/test';
import { resetData } from './helpers';

/**
 * A layout load that started before a color-scheme switch, and lands after
 * it, must not switch the scheme back.
 *
 * The Preferences switcher writes the gs-scheme cookie at once and PATCHes the
 * pref without invalidating. The (app) layout's cookie-sync effect used to
 * read the pref through `data`, so any layout load (a focus refresh, a turn
 * completing) re-ran it, and one answered before the PATCH carried the old
 * pref and wrote it back over the user's choice.
 */

test.beforeEach(() => {
	resetData();
});
test.skip(({ isMobile }) => isMobile, 'same code path on mobile; one viewport is enough');

function scheme(page: Page) {
	return page.evaluate(() => ({
		cookie: /(?:^|;\s*)gs-scheme=([^;]+)/.exec(document.cookie)?.[1],
		attr: document.documentElement.dataset.scheme,
	}));
}

test('a stale layout load does not revert a scheme switch', async ({ page }) => {
	await page.emulateMedia({ colorScheme: 'light' });
	await page.goto('/settings/preferences');
	await page.waitForLoadState('networkidle');

	// Answer the next layout load from the server NOW, while the pref is
	// still `system`, but hold the response until after the switch.
	let release!: () => void;
	const held = new Promise<void>((r) => (release = r));
	let answered!: () => void;
	const stale = new Promise<void>((r) => (answered = r));
	let armed = true;
	await page.route('**/__data.json*', async (route) => {
		if (!armed) return route.continue();
		armed = false;
		const response = await route.fetch();
		answered();
		await held;
		await route.fulfill({ response });
	});
	// The layout's resume refresh, as on refocusing the window.
	await page.evaluate(() => window.dispatchEvent(new Event('focus')));
	await stale;

	const patched = page.waitForResponse(
		(r) => r.url().includes('/api/user/preferences') && r.request().method() === 'PATCH',
	);
	await page.getByRole('button', { name: 'Dark', exact: true }).click();
	await patched;
	expect(await scheme(page)).toEqual({ cookie: 'dark', attr: 'dark' });

	// Let the held load land and the layout apply it before looking.
	const landed = page.waitForResponse((r) => r.url().includes('__data.json'));
	release();
	await landed;
	await page.evaluate(
		() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))),
	);
	expect(await scheme(page)).toEqual({ cookie: 'dark', attr: 'dark' });
});
