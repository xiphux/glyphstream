import { test, expect, type Page } from '@playwright/test';
import { MOCK_REPLY, resetData, seedPreferences, selectModel } from './helpers';

/**
 * Emoji reactions, end to end.
 *
 * Worth a browser test even though `relay-reactions.test.ts` already drives the
 * real relay against a real DB, because everything that makes a reaction feel
 * like one lives in the seams that test stops short of:
 *
 * - The `reaction` SSE frame has to survive `consumeChatStream` → the turn
 *   controller → a DOM badge. Both halves are unit-tested; the join isn't.
 * - The badge has to SURVIVE the handoff at `done`, when the live value is
 *   cleared and the derived map takes over. Reasoning says there's no gap;
 *   only a browser can show there's no flicker or disappearance.
 * - "The call renders as nothing" is a claim about the whole rendering stack,
 *   and it's the one claim a unit test is worst at: it's an absence.
 *
 * `mock-chat-tools` is the only fixture model advertising tool support, and it
 * reacts iff `react_to_message` is actually in the `tools[]` it was sent — so
 * the negative cases below assert the real gate (toggle → disabled_features →
 * tool filter), not a mock following instructions.
 */

test.beforeEach(() => resetData());

/** The emoji tests/e2e/fixtures/mock-upstream.mjs reacts with. */
const EMOJI = '🎉';

/** The tapback badge, addressed the way a screen reader sees it. */
const reactionBadge = (page: Page) =>
	page.getByRole('img', { name: new RegExp(`reacted with ${EMOJI}`) });

/** Send `prompt` from home against the tool-capable model and wait for the turn
 *  to settle. Returns the conversation id. */
async function sendToToolModel(page: Page, prompt: string): Promise<string> {
	await page.goto('/');
	await expect(page.getByRole('button', { name: 'Select model' })).toContainText('Mock Chat');
	await selectModel(page, /^Mock Chat Tools$/);
	await page.locator('textarea').first().fill(prompt);
	const send = page.getByRole('button', { name: 'Send message' });
	await expect(send).toBeEnabled();
	await send.click();
	await page.waitForURL(/\/chat\/[^/]+$/);
	await expect(page.getByText(MOCK_REPLY)).toBeVisible();
	// Gate on the turn settling, so the next test's resetData() can't delete the
	// conversation while the relay's recorder is still writing.
	await expect(send).toBeVisible();
	return page.url().split('/chat/')[1];
}

test.describe('the assistant reacts', () => {
	test('the badge lands on the user message, and the call renders as nothing', async ({ page }) => {
		await sendToToolModel(page, 'I got the job!!');

		await expect(reactionBadge(page)).toBeVisible();
		await expect(reactionBadge(page)).toHaveText(EMOJI);

		// The reply is untouched — a reaction accompanies an answer, never replaces
		// one.
		await expect(page.getByText(MOCK_REPLY)).toBeVisible();

		// And the call itself left no trace: no tool block, no tool name, no
		// spinner stuck mid-"executing".
		await expect(page.getByText('react_to_message')).toHaveCount(0);
		await expect(page.getByText(/Reaction/)).toHaveCount(0);
	});

	test('the badge belongs to the user bubble, not the reply', async ({ page }) => {
		await sendToToolModel(page, 'I got the job!!');

		// `#msg-<id>` is the per-message article. The badge must sit inside the
		// FIRST one (the user's), which is the whole point of re-attaching a
		// reaction emitted by the assistant to the message above it.
		const bubbles = page.locator('[id^="msg-"]');
		await expect(bubbles).toHaveCount(2);
		await expect(bubbles.first().getByRole('img', { name: /reacted with/ })).toBeVisible();
		await expect(bubbles.last().getByRole('img', { name: /reacted with/ })).toHaveCount(0);
	});

	test('the turn ends on the reaction instead of buying another iteration', async ({ page }) => {
		await sendToToolModel(page, 'I got the job!!');

		// A looped turn would persist assistant(tool_call) → tool → assistant(text)
		// and render THREE bubbles (tool rows are filtered out, the two assistant
		// rows are not). Two means the relay stopped, which is the short-circuit
		// observed from the outside.
		await expect(page.locator('[id^="msg-"]')).toHaveCount(2);
	});

	test('the badge survives a reload', async ({ page }) => {
		// The live frame is gone on a fresh load: this is the persisted path, read
		// back off the assistant row's tool_call part by buildRenderedConversation.
		const convId = await sendToToolModel(page, 'I got the job!!');
		await page.goto(`/chat/${convId}`);

		await expect(reactionBadge(page)).toBeVisible();
		await expect(page.getByText('react_to_message')).toHaveCount(0);
	});
});

test.describe('the assistant does not react', () => {
	test('with the conversation toggle off, no tool is offered and no badge appears', async ({
		page,
	}) => {
		await page.goto('/');
		await expect(page.getByRole('button', { name: 'Select model' })).toContainText('Mock Chat');
		await selectModel(page, /^Mock Chat Tools$/);

		await page.getByRole('button', { name: 'Feature toggles' }).click();
		const toggle = page.getByRole('switch', { name: 'Emoji reactions' });
		await expect(toggle).toHaveAttribute('aria-checked', 'true');
		await toggle.click();
		await expect(toggle).toHaveAttribute('aria-checked', 'false');
		await page.keyboard.press('Escape');

		await page.locator('textarea').first().fill('I got the job!!');
		const send = page.getByRole('button', { name: 'Send message' });
		await expect(send).toBeEnabled();
		await send.click();
		await page.waitForURL(/\/chat\/[^/]+$/);
		await expect(page.getByText(MOCK_REPLY)).toBeVisible();
		await expect(send).toBeVisible();

		// The mock reacts only when `react_to_message` is in the tools[] it was
		// sent, so an absent badge here means the category gate actually stripped
		// the tool — not that the mock declined.
		await expect(reactionBadge(page)).toHaveCount(0);
	});

	test('a user who turned reactions off by default starts every chat that way', async ({
		page,
	}) => {
		seedPreferences({ defaultDisabledFeatures: ['reactions'] });

		await page.goto('/');
		await expect(page.getByRole('button', { name: 'Select model' })).toContainText('Mock Chat');
		await page.getByRole('button', { name: 'Feature toggles' }).click();
		await expect(page.getByRole('switch', { name: 'Emoji reactions' })).toHaveAttribute(
			'aria-checked',
			'false',
		);
		// Every other category is untouched — the preference is a per-category
		// baseline, not a blanket "start with everything off".
		await expect(page.getByRole('switch', { name: 'Web access' })).toHaveAttribute(
			'aria-checked',
			'true',
		);
		await page.keyboard.press('Escape');

		await sendToToolModel(page, 'I got the job!!');
		await expect(reactionBadge(page)).toHaveCount(0);
	});
});
