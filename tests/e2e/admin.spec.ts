import { test, expect } from '@playwright/test';
import { resetData, sendChatFromHome } from './helpers';
import { STORAGE_STATE_USER2_PATH } from './global-setup';

/**
 * Multi-user surface: the admin invite UI, cross-user data isolation, and the
 * requireAdmin gate. The seeded default user (global-setup) is an admin; a
 * second seeded account (TEST_USER_2 / STORAGE_STATE_USER2_PATH) is a normal
 * 'user' used to prove isolation + gating through real route handlers — the
 * layer the query-level unit tests can't reach.
 *
 * The OAuth/passkey ceremonies are intentionally out of scope here (the
 * harness cookie-injects sessions; see global-setup), so this exercises the
 * /join page's invalid-token state rather than a full redemption.
 */

test.describe('admin: invites', () => {
	test.beforeEach(() => resetData());

	test('admin can create an invite (one-time link) and revoke it', async ({ page }) => {
		await page.goto('/settings/admin');
		await expect(page.getByRole('heading', { name: 'Administration' })).toBeVisible();

		// Create → the one-time join URL is revealed and the invite lands in
		// the pending list as 'active'.
		await page.getByRole('button', { name: 'Create invite' }).click();
		const urlInput = page.locator('input[readonly]');
		await expect(urlInput).toBeVisible();
		await expect(urlInput).toHaveValue(/\/join\//);
		await expect(page.getByText('active')).toBeVisible();

		// Revoke (confirm dialog) → the pending list empties. The trash's
		// aria-label is "Revoke invite"; the dialog's confirm button is exactly
		// "Revoke".
		await page.getByRole('button', { name: 'Revoke invite' }).click();
		await page.getByRole('button', { name: 'Revoke', exact: true }).click();
		await expect(page.getByText('No pending invites.')).toBeVisible();
	});
});

test.describe('multi-user isolation + admin gating', () => {
	test.beforeEach(() => resetData());

	test("a non-owner can't open another user's conversation; a non-admin is barred from /settings/admin", async ({
		page,
		browser,
	}) => {
		// User A (admin, default storageState) creates a conversation.
		const convId = await sendChatFromHome(page, 'isolation probe');

		// User B — the second, non-admin account — in its own context.
		const ctxB = await browser.newContext({ storageState: STORAGE_STATE_USER2_PATH });
		try {
			const pageB = await ctxB.newPage();

			// B can't read A's conversation: the ownership-scoped load 404s.
			const convResp = await pageB.goto(`/chat/${convId}`);
			expect(convResp?.status()).toBe(404);

			// B isn't an admin: requireAdmin 403s the admin surface.
			const adminResp = await pageB.goto('/settings/admin');
			expect(adminResp?.status()).toBe(403);
		} finally {
			await ctxB.close();
		}
	});
});

test.describe('invite redemption page', () => {
	// The /join page redirects authenticated users home, so clear the seeded
	// session for these — an invitee arrives logged-out.
	test.use({ storageState: { cookies: [], origins: [] } });

	test('an invalid / unknown invite token shows the invalid state and no sign-up buttons', async ({
		page,
	}) => {
		await page.goto('/join/this-token-does-not-exist');
		await expect(page.getByText(/invite link is invalid/i)).toBeVisible();
		// No way to proceed when the invite isn't valid.
		await expect(page.getByRole('button', { name: /passkey/i })).toHaveCount(0);
		await expect(page.getByRole('button', { name: /Continue with GitHub/i })).toHaveCount(0);
	});
});
