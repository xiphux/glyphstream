import { test, expect } from '@playwright/test';
import { openSidebar } from './helpers';

/**
 * The debug panel's hidden entry point, end to end.
 *
 * Everything else about this feature is unit-tested — the double-activate
 * timing (tests/unit/double-activate.test.ts) and the arithmetic behind the
 * rows (tests/unit/debug-info.test.ts). What neither can see is whether the
 * handler is still attached to the version number in the sidebar header, and
 * that is the whole feature: nothing in the UI hints the panel exists, so a
 * detached handler makes it permanently unreachable with no one to report it.
 *
 * Also pins the negative: one click must do nothing. If that regresses, every
 * ordinary click on the header pops a dialog — the loudest possible failure
 * for something meant to stay invisible.
 */

/**
 * The button carries no aria-label, so its accessible name is the rendered
 * "v1.2.3" — deliberately, since a product-prefixed label collided with the
 * theme picker's "GlyphStream Signature frosted glass" on /settings/preferences
 * and broke an unrelated spec. Matched by shape rather than a literal so the
 * suite doesn't need editing on every release.
 */
const VERSION_BUTTON = /^v\d+\.\d+\.\d+/;

test('the version number stays inert on a single click', async ({ page, isMobile }) => {
	await page.goto('/');
	await openSidebar(page, !!isMobile);
	await page.getByRole('button', { name: VERSION_BUTTON }).click();
	// Deliberately longer than the 450ms pairing window: a second click after
	// this wait must not complete a pair either.
	await page.waitForTimeout(900);
	await expect(page.getByRole('dialog')).toBeHidden();
});

test('double-activating the version number opens the debug panel', async ({ page, isMobile }) => {
	await page.goto('/');
	await openSidebar(page, !!isMobile);

	const version = page.getByRole('button', { name: VERSION_BUTTON });
	await version.dblclick();

	const panel = page.getByRole('dialog');
	await expect(panel).toBeVisible();
	await expect(panel).toContainText('Debug info');

	// The rows that prove the real Performance entry was read, not a
	// placeholder: the Server-Timing header set in hooks.server.ts, and the
	// hashed-chunk accounting. Values are machine-dependent, so assert shape.
	await expect(panel).toContainText('Server (SSR)');
	await expect(panel).toContainText(/\d+ ms/);
	await expect(panel).toContainText('App chunks');

	// Doubles as the live check on the resourceUsage counters: the row renders
	// only when the server stamped `cpu`, which it does only for a signed-in
	// document, so a header that silently lost the field fails here rather than
	// surfacing months later as a diagnostic that reads blank in the one launch
	// it was built to explain.
	await expect(panel).toContainText('Server CPU');
	await expect(panel).toContainText(/% of wall/);

	await panel.getByRole('button', { name: 'Close' }).click();
	await expect(panel).toBeHidden();
});

test('the copy confirmation renders above the panel, not behind its backdrop', async ({
	page,
	isMobile,
	context,
}) => {
	await context.grantPermissions(['clipboard-read', 'clipboard-write']);
	await page.goto('/');
	await openSidebar(page, !!isMobile);
	await page.getByRole('button', { name: VERSION_BUTTON }).dblclick();

	const panel = page.getByRole('dialog');
	await expect(panel).toBeVisible();
	await panel.getByRole('button', { name: 'Copy' }).click();

	const toast = page.getByText('Debug info copied');
	await expect(toast).toBeVisible();

	// toBeVisible() is NOT the assertion that matters here, and asserting only
	// that is what let this ship broken: on the overlay tier the toast tied with
	// the dialog's full-screen backdrop, lost on paint order, and rendered behind
	// bg-black/60 + backdrop-blur — laid out, unoccluded by any DOM check,
	// reported visible by Playwright, and unreadable to a human. So ask the
	// browser what is actually topmost at the toast's own centre point.
	const topmost = await toast.evaluate((el) => {
		const r = el.getBoundingClientRect();
		const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
		return hit === el || el.contains(hit);
	});
	expect(topmost, 'the toast is painted under the dialog backdrop').toBe(true);
});
