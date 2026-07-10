import { test, expect, type Page } from '@playwright/test';
import { MOCK_REPLY, generateImageFromHome, resetData, sendChatFromHome } from './helpers';

/**
 * "New chat from this prompt" — the user-bubble action that seeds the new-chat
 * composer from an existing prompt, so a small variation doesn't need a
 * copy/paste round-trip.
 *
 * The load-bearing behaviors, in order of what would hurt most if they broke:
 *   - it never submits (the whole point is to tweak first);
 *   - the model comes along, so a text prompt can't land on an image model or
 *     vice versa just because the new-chat page defaults to Mock Chat;
 *   - a fan-out's whole cart comes along, rebuilt from `dispatched_models` on
 *     the user row rather than from the surviving replies;
 *   - a typed draft that gets displaced is recoverable.
 *
 * Clean slate per test, like the other specs (one webServer/DB across projects).
 */

test.beforeEach(() => resetData());

const REUSE = 'New chat from this prompt';

/** Click the reuse button on the conversation's (only) user bubble. */
async function reuseFirstPrompt(page: Page): Promise<void> {
	await page.getByRole('button', { name: REUSE }).first().click();
	await page.waitForURL((url) => url.pathname === '/');
}

test.describe('flow: new chat from this prompt', () => {
	test('carries the prompt and its model, and submits nothing', async ({ page }) => {
		// An IMAGE conversation on purpose: the new-chat page's default-model
		// effect would pick Mock Chat, so seeing Mock Image proves the model rode
		// along rather than being re-defaulted into a nonsensical modality.
		const prompt = 'a cat wearing a tiny hat';
		await generateImageFromHome(page, prompt);

		await reuseFirstPrompt(page);

		await expect(page.locator('textarea').first()).toHaveValue(prompt);
		await expect(page.getByRole('button', { name: 'Select model' })).toContainText('Mock Image');

		// Nothing was sent: still on the new-chat page with an armed Send button,
		// and no second conversation exists.
		await expect(page).toHaveURL(/\/$/);
		await expect(page.getByRole('button', { name: 'Send message' })).toBeEnabled();
		await expect(page.getByText(MOCK_REPLY)).toHaveCount(0);
	});

	test('restores the full compare cart of a fan-out, after a branch is discarded', async ({
		page,
	}) => {
		// Fan one prompt across two chat models, then resolve the comparison by
		// picking one — the losing branch stays in the tree as a sibling.
		const prompt = 'Compare these two models';
		await page.goto('/');
		await expect(page.getByRole('button', { name: 'Select model' })).toContainText('Mock Chat');
		await page.getByRole('button', { name: 'Select model' }).click();
		await page.getByRole('button', { name: 'Multiple' }).click();
		await page.getByRole('option', { name: /^Mock Chat Slow$/ }).click();
		await page.keyboard.press('Escape');
		await expect(page.getByRole('button', { name: 'Select model' })).toContainText('2 models');
		await page.locator('textarea').first().fill(prompt);
		await page.getByRole('button', { name: 'Send to 2 models' }).click();
		await page.waitForURL(/\/chat\/[^/]+$/);

		const continueButtons = page.getByRole('button', { name: /continue with this/i });
		await expect(continueButtons).toHaveCount(2);
		for (const b of await continueButtons.all()) await expect(b).toBeEnabled();
		await continueButtons.first().click();
		await expect(page.getByText('Comparing 2 models')).toHaveCount(0);
		await expect(page.getByRole('button', { name: 'Send message' })).toBeVisible();

		// Delete the sibling branch the user didn't pick. This is the case that
		// motivated recording the dispatch: reconstructing the cart from the
		// surviving replies would now see exactly one model. The reply that's left
		// is Mock Chat's — so a replies-derived cart would be a single model.
		await expect(page.getByText(MOCK_REPLY)).toHaveCount(1);
		await page.getByRole('button', { name: 'Delete this branch' }).click();
		await page.getByRole('button', { name: 'Delete', exact: true }).click();
		// Branch nav disappears once the assistant has no siblings left.
		await expect(page.getByRole('button', { name: 'Next sibling' })).toHaveCount(0);

		await reuseFirstPrompt(page);

		// Both models are back in the cart, even though only one reply survives.
		await expect(page.locator('textarea').first()).toHaveValue(prompt);
		await expect(page.getByRole('button', { name: 'Select model' })).toContainText('2 models');
		await expect(page.getByRole('button', { name: 'Send to 2 models' })).toBeEnabled();
	});

	test('displacing a typed draft is undoable', async ({ page }) => {
		const prompt = 'the original prompt';
		await sendChatFromHome(page, prompt);

		// Leave an unsent draft in the new-chat box, then come back and reuse.
		const draft = 'something I was still writing';
		await page.goto('/');
		await page.locator('textarea').first().fill(draft);
		// The draft autosave is debounced (500ms); let it land before navigating.
		await expect
			.poll(async () =>
				page.evaluate(() => window.localStorage.getItem('glyphstream:composerDraft:new')),
			)
			.toContain('still writing');

		await page.goBack();
		await page.waitForURL(/\/chat\/[^/]+$/);
		await reuseFirstPrompt(page);

		const textarea = page.locator('textarea').first();
		await expect(textarea).toHaveValue(prompt);

		// The displaced draft is offered back rather than silently lost.
		await page.getByRole('button', { name: 'Undo' }).click();
		await expect(textarea).toHaveValue(draft);
	});
});
