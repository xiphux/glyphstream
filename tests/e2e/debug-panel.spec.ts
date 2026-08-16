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

test('the version number stays inert on a single click', async ({ page, isMobile }) => {
	await page.goto('/');
	await openSidebar(page, !!isMobile);
	await page.getByRole('button', { name: /GlyphStream version/ }).click();
	// Deliberately longer than the 450ms pairing window: a second click after
	// this wait must not complete a pair either.
	await page.waitForTimeout(900);
	await expect(page.getByRole('dialog')).toBeHidden();
});

test('double-activating the version number opens the debug panel', async ({ page, isMobile }) => {
	await page.goto('/');
	await openSidebar(page, !!isMobile);

	const version = page.getByRole('button', { name: /GlyphStream version/ });
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

	await panel.getByRole('button', { name: 'Close' }).click();
	await expect(panel).toBeHidden();
});
