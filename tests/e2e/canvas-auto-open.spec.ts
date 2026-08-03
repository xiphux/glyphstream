import { test, expect } from '@playwright/test';
import { resetData, seedCanvas, seedConversation, seedConversationMessages } from './helpers';

/**
 * Entering a conversation that already has a canvas opens the pane beside it on
 * a wide viewport. The open is driven by an $effect on the chat page, and it is
 * the ONLY automatic `canvas.show()` — everything else is a user click or a
 * mid-turn `canvas_version` event.
 *
 * Worth an e2e rather than a component test because the bug this pins was a
 * mount-ordering one: a guard added to the page's state-seeding effect made its
 * first run early-return, and the auto-open was the one thing that effect did
 * that wasn't ALSO initialized at declaration. Nothing below the page level can
 * see that — the pane, the card and the controller were all individually fine.
 *
 * The two mount paths are asserted separately because they failed
 * independently: a full page load mounts the component fresh (broken), while
 * /chat/a -> /chat/b reuses it and only swaps `data` (kept working). Testing
 * only the second is exactly how the regression slipped through.
 */

test.beforeEach(() => resetData());

const CANVAS = { name: 'Design notes', body: 'Canvas body text.' };

test.describe('canvas auto-open on entering a conversation', () => {
	test('opens on a full page load of the conversation', async ({ page }) => {
		const convId = seedConversation('Has a canvas');
		seedConversationMessages(convId, 1);
		seedCanvas(convId, CANVAS.name, CANVAS.body);

		await page.setViewportSize({ width: 1280, height: 900 });
		await page.goto(`/chat/${convId}`);

		await expect(page.getByRole('complementary', { name: 'Canvas' })).toBeVisible();
		await expect(page.getByRole('heading', { name: CANVAS.name })).toBeVisible();
	});

	test('opens when arriving from a non-chat route', async ({ page }) => {
		const convId = seedConversation('Canvas from elsewhere');
		seedConversationMessages(convId, 1);
		seedCanvas(convId, CANVAS.name, CANVAS.body);

		await page.setViewportSize({ width: 1280, height: 900 });
		// Start somewhere that is NOT /chat/[id], so entering mounts the page fresh.
		await page.goto('/gallery');
		await page.goto(`/chat/${convId}`);

		await expect(page.getByRole('complementary', { name: 'Canvas' })).toBeVisible();
	});

	test('stays closed on a narrow viewport', async ({ page }) => {
		const convId = seedConversation('Canvas on mobile');
		seedConversationMessages(convId, 1);
		seedCanvas(convId, CANVAS.name, CANVAS.body);

		// The pane is a full-screen overlay below md, so auto-opening would bury
		// the conversation the user just entered.
		await page.setViewportSize({ width: 480, height: 900 });
		await page.goto(`/chat/${convId}`);

		await expect(page.getByRole('heading', { name: 'Canvas on mobile' }).first()).toBeVisible();
		await expect(page.getByRole('complementary', { name: 'Canvas' })).toBeHidden();
	});

	test('does not reopen a pane the user closed', async ({ page }) => {
		const convId = seedConversation('Closable canvas');
		seedConversationMessages(convId, 1);
		seedCanvas(convId, CANVAS.name, CANVAS.body);

		await page.setViewportSize({ width: 1280, height: 900 });
		await page.goto(`/chat/${convId}`);

		const pane = page.getByRole('complementary', { name: 'Canvas' });
		await expect(pane).toBeVisible();
		await page.getByRole('button', { name: 'Close canvas' }).click();
		await expect(pane).toBeHidden();

		// The latch is per-conversation, so nothing that re-runs the effect on this
		// same conversation may undo the close.
		await page.waitForTimeout(300);
		await expect(pane).toBeHidden();
	});
});
