import { test, expect } from '@playwright/test';
import { resetData, MOCK_REPLY } from './helpers';

/**
 * Private ("incognito") chat — the create-and-persist flow that only a real
 * toggle → create → navigate → reload round-trip exercises. The airgap seals
 * (content-out summary/search gating, request-time feature seal) are covered by
 * unit tests; here we prove the UI half end-to-end:
 *
 *   - the new-chat toggle arms private mode and re-tints the app (data-private on
 *     <html>),
 *   - a chat created while armed persists as private (badge + sidebar marker) and
 *     survives a reload (the flag is a real DB column, not transient page state),
 *   - a normal chat started afterwards is NOT private (the toggle is per-new-chat,
 *     and the re-tint clears when you leave the private view).
 *
 * Clean slate per test for the one-DB-across-projects reason (see resetData).
 */

test.beforeEach(() => resetData());

const html = (page: import('@playwright/test').Page) => page.locator('html');

test.describe('private chat', () => {
	test('toggle arms the incognito re-tint on the new-chat screen', async ({ page }) => {
		await page.goto('/');
		await expect(page.getByRole('button', { name: 'Select model' })).toContainText('Mock Chat');

		// Not private by default.
		await expect(html(page)).not.toHaveAttribute('data-private', /.*/);

		await page.getByRole('button', { name: /Private chat/i }).click();
		// The whole app re-tints (attribute present, value is the empty string).
		await expect(html(page)).toHaveAttribute('data-private', '');

		// The personalized greeting is replaced by a private-mode explainer — a
		// mode that airgaps your personal info shouldn't open with "Hi, {name}".
		// getByRole is aria-hidden-aware: the inactive layer is aria-hidden, so the
		// "Private chat" heading resolves only when private is actually armed.
		await expect(page.getByRole('heading', { name: 'Private chat' })).toBeVisible();
		await expect(page.getByText(/Off the record/)).toBeVisible();

		// The accent aura retracts (opacity 0). Guards a real cascade gotcha: the
		// entrance keyframes' fill-mode `both` pins opacity at 1 and beats a plain
		// `opacity: 0`, so the private rule must also cancel the animation.
		await expect
			.poll(() => page.locator('.aura').evaluate((el) => getComputedStyle(el).opacity))
			.toBe('0');

		// Toggling off clears it again.
		await page.getByRole('button', { name: /Private/i }).click();
		await expect(html(page)).not.toHaveAttribute('data-private', /.*/);
	});

	test('a chat created while private persists as private and survives reload', async ({
		page,
		isMobile,
	}) => {
		await page.goto('/');
		await expect(page.getByRole('button', { name: 'Select model' })).toContainText('Mock Chat');

		// Arm private, then send — the created conversation should be sealed.
		await page.getByRole('button', { name: /Private chat/i }).click();
		await expect(html(page)).toHaveAttribute('data-private', '');

		await page.locator('textarea').first().fill('a private thought');
		const send = page.getByRole('button', { name: 'Send message' });
		await expect(send).toBeEnabled();
		await send.click();
		await page.waitForURL(/\/chat\/[^/]+$/);
		await expect(page.getByText(MOCK_REPLY)).toBeVisible();
		await expect(page.getByRole('button', { name: 'Send message' })).toBeVisible();

		// Private badge shows + still re-tinted on the created chat. The badge lives
		// in the ChatHeader on desktop and in the mobile top bar on small screens
		// (the other is display:none), so target whichever copy is actually visible.
		const privateBadge = page.getByText('Private', { exact: true }).and(page.locator(':visible'));
		await expect(privateBadge).toBeVisible();
		await expect(html(page)).toHaveAttribute('data-private', '');

		// Reload — the flag is persisted (a real column), so it comes back private.
		await page.reload();
		await expect(page.getByText(MOCK_REPLY)).toBeVisible();
		await expect(privateBadge).toBeVisible();
		await expect(html(page)).toHaveAttribute('data-private', '');

		// Sidebar marks the row as private (aria-label on the leading mask glyph).
		if (isMobile) await page.getByRole('button', { name: 'Open menu' }).click();
		await expect(page.getByLabel('Private chat').last()).toBeVisible();
	});

	test('a normal chat started after a private one is not private', async ({ page }) => {
		// First, a private chat.
		await page.goto('/');
		await expect(page.getByRole('button', { name: 'Select model' })).toContainText('Mock Chat');
		await page.getByRole('button', { name: /Private chat/i }).click();
		await page.locator('textarea').first().fill('secret one');
		await page.getByRole('button', { name: 'Send message' }).click();
		await page.waitForURL(/\/chat\/[^/]+$/);
		await expect(page.getByText(MOCK_REPLY)).toBeVisible();
		await expect(page.getByRole('button', { name: 'Send message' })).toBeVisible();

		// Now a brand-new chat from home — the toggle resets, so it's normal.
		await page.goto('/');
		await expect(page.getByRole('button', { name: 'Select model' })).toContainText('Mock Chat');
		await expect(html(page)).not.toHaveAttribute('data-private', /.*/);

		await page.locator('textarea').first().fill('a public thought');
		await page.getByRole('button', { name: 'Send message' }).click();
		await page.waitForURL(/\/chat\/[^/]+$/);
		await expect(page.getByText(MOCK_REPLY)).toBeVisible();

		// No badge, no re-tint on the normal chat.
		await expect(page.getByText('Private', { exact: true })).toBeHidden();
		await expect(html(page)).not.toHaveAttribute('data-private', /.*/);
	});
});
