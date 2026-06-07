import { test, expect, type Page } from '@playwright/test';
import { MOCK_REPLY, resetData } from './helpers';

/**
 * Multi-model fan-out flow — the headline feature, previously uncovered by e2e.
 * Two specs:
 *   - happy path: compare two chat models → a grid of N streaming columns →
 *     "Continue with this" collapses back to a linear thread.
 *   - recovery: a visibilitychange (desktop tab-switch) mid-fan-out must NOT
 *     drop the live grid or surface an error — the regression the controller's
 *     handoff guard fixes, exercised end-to-end.
 *
 * Both use Mock Chat + Mock Chat Slow (mock-upstream.mjs) so one column is still
 * streaming when assertions/events run. Clean slate per test, like the other
 * specs (one webServer/DB across projects).
 */

test.beforeEach(() => resetData());

/**
 * From the home page, put the picker in compare mode with two chat models
 * (the default Mock Chat, seeded on toggle, + Mock Chat Slow), type `prompt`,
 * and send. Lands on /chat/[id] with the fan-out grid up.
 */
async function fanOutTwoModels(page: Page, prompt: string): Promise<void> {
	await page.goto('/');
	await expect(page.getByRole('button', { name: 'Select model' })).toContainText('Mock Chat');

	// Open the picker, flip on "Multiple" (seeds the current Mock Chat as
	// variation 1), then add Mock Chat Slow as the second branch.
	await page.getByRole('button', { name: 'Select model' }).click();
	await page.getByRole('button', { name: 'Multiple' }).click();
	await page.getByRole('option', { name: /^Mock Chat Slow$/ }).click();
	await page.keyboard.press('Escape');

	// Trigger reflects the 2-model cart; the next send fans out.
	await expect(page.getByRole('button', { name: 'Select model' })).toContainText('2 models');

	await page.locator('textarea').first().fill(prompt);
	// In compare mode the send button is labelled "Send to N models".
	const send = page.getByRole('button', { name: 'Send to 2 models' });
	await expect(send).toBeEnabled();
	await send.click();
	await page.waitForURL(/\/chat\/[^/]+$/);
}

test.describe('flow: multi-model fan-out', () => {
	test('compares two models in a grid, then picks one to continue', async ({ page }) => {
		await fanOutTwoModels(page, 'Compare these two models');

		// The compare grid renders one column per model.
		await expect(page.getByText('Comparing 2 models')).toBeVisible();
		// Both columns stream the same deterministic reply → two copies on the page
		// (the linear thread is pinned at the user message during fan-out).
		await expect(page.getByText(MOCK_REPLY)).toHaveCount(2, { timeout: 15_000 });

		// Wait for both columns to settle (continue enables only on `done`, i.e.
		// the recorder persisted) before picking — gates out the resetData race.
		const continueButtons = page.getByRole('button', { name: /continue with this/i });
		await expect(continueButtons).toHaveCount(2);
		for (const b of await continueButtons.all()) await expect(b).toBeEnabled();

		// Pick the first column → selectBranch advances the active leaf into it and
		// the view collapses back to a single linear thread.
		await continueButtons.first().click();
		await expect(page.getByText('Comparing 2 models')).toHaveCount(0);
		await expect(page.getByText(MOCK_REPLY)).toHaveCount(1);
		await expect(page.getByRole('button', { name: 'Send message' })).toBeVisible();
	});

	test('survives a visibilitychange mid-fan-out without dropping the grid', async ({ page }) => {
		await fanOutTwoModels(page, 'Fan-out recovery hello');

		// Grid is up and at least one column is still streaming (Mock Chat Slow).
		await expect(page.getByText('Comparing 2 models')).toBeVisible();

		// Desktop tab-switch: hidden→visible. Playwright doesn't kill the fetches,
		// so the live grid must stay (the controller hands off to recovery only on
		// a real branch-stream error, not on a benign visibilitychange).
		await page.evaluate(() => {
			Object.defineProperty(document, 'visibilityState', {
				configurable: true,
				get: () => 'hidden',
			});
			document.dispatchEvent(new Event('visibilitychange'));
		});
		await page.waitForTimeout(150);
		await page.evaluate(() => {
			Object.defineProperty(document, 'visibilityState', {
				configurable: true,
				get: () => 'visible',
			});
			document.dispatchEvent(new Event('visibilitychange'));
		});

		// Both columns still finish, and no error toast (role=status) surfaced.
		await expect(page.getByText(MOCK_REPLY)).toHaveCount(2, { timeout: 15_000 });
		await expect(page.getByText('Comparing 2 models')).toBeVisible();
		await expect(page.getByRole('status')).toHaveCount(0);

		// Gate on the grid fully settling before the test ends: "Continue with
		// this" enables only once a column reaches `done` (its recorder has
		// persisted), so this avoids the next test's resetData racing an
		// in-flight branch recorder (the FK-constraint race helpers.ts warns of).
		const continueButtons = page.getByRole('button', { name: /continue with this/i });
		await expect(continueButtons).toHaveCount(2);
		for (const b of await continueButtons.all()) await expect(b).toBeEnabled();
	});
});
