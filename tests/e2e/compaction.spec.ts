import { test, expect } from '@playwright/test';
import {
	MOCK_REPLY,
	resetData,
	selectModel,
	sendChatFromHome,
	sendFollowup,
	setAutoCompaction,
} from './helpers';

// Clean slate before each — see resetData's header. Each test also resets the
// auto-compaction preference so it can't leak across specs.
test.beforeEach(() => {
	resetData();
	setAutoCompaction(false, 80);
});

/**
 * Conversation compaction, end-to-end against the mock upstream
 * (tests/e2e/fixtures/mock-upstream.mjs). The mock returns a fixed summary
 * (MOCK SUMMARY…) whenever it sees the summarizer system prompt, and advertises
 * a tiny-window model (Mock Chat Tiny, 50-token n_ctx) so auto-compaction's
 * threshold crossing is deterministic.
 *
 * The pure token math / cut logic is unit-tested; these specs pin the browser
 * wiring the unit layer can't: the Compact button gating, the streamed summary
 * settling into a collapsed divider with the real messages still inline, and
 * auto-compaction firing on a send before the reply.
 */

const COMPACT = /compact|summariz/i; // icon-only button in the budget bar (aria-label/title)
const SUMMARY_DIVIDER = /Context summary/;

test.describe('manual compaction', () => {
	test('Compact is gated until there is history, then folds older turns into a summary', async ({
		page,
	}) => {
		await sendChatFromHome(page, 'first question'); // turn 1 (Mock Chat)

		// Too little history to compact yet.
		const compact = page.getByRole('button', { name: COMPACT });
		await expect(compact).toBeDisabled();

		await sendFollowup(page, 'second question'); // turn 2
		await sendFollowup(page, 'third question'); // turn 3 → now compactable

		await expect(compact).toBeEnabled();
		await compact.click();

		// The summary lands as a collapsed divider, the real turns stay inline.
		// Scope text to the message body (the prompt also appears as the title /
		// sidebar link, which would be a strict-mode multi-match).
		const divider = page.getByRole('button', { name: SUMMARY_DIVIDER });
		await expect(divider).toBeVisible();
		await expect(
			page.locator('div.whitespace-pre-wrap', { hasText: 'first question' }),
		).toBeVisible();
		await expect(
			page.locator('div.whitespace-pre-wrap', { hasText: 'third question' }),
		).toBeVisible();

		// Collapsed by default; expands to reveal the generated summary.
		await expect(page.getByText('MOCK SUMMARY')).toBeHidden();
		await divider.click();
		await expect(page.getByText('MOCK SUMMARY')).toBeVisible();
	});
});

test.describe('auto-compaction', () => {
	test('fires on a send once the thread crosses the threshold, before the reply', async ({
		page,
	}) => {
		// 10% of the tiny model's 50-token window = 5 tokens; every real reply
		// reports 18, so any thread with enough turns is over the line.
		setAutoCompaction(true, 10);

		await page.goto('/');
		await selectModel(page, 'Mock Chat Tiny');

		// Turn 1 from the home composer.
		await page.locator('textarea').first().fill('one');
		const send = page.getByRole('button', { name: 'Send message' });
		await expect(send).toBeEnabled();
		await send.click();
		await page.waitForURL(/\/chat\/[^/]+$/);
		await expect(page.getByText(MOCK_REPLY).first()).toBeVisible();
		await expect(send).toBeVisible();

		await sendFollowup(page, 'two');
		await sendFollowup(page, 'three');

		// No compaction yet — under the turn count, nobody clicked Compact.
		await expect(page.getByRole('button', { name: SUMMARY_DIVIDER })).toHaveCount(0);

		// The next send auto-compacts first (no Compact click), then replies.
		await sendFollowup(page, 'four');
		await expect(page.getByRole('button', { name: SUMMARY_DIVIDER })).toHaveCount(1);
		// The reply still arrived after the summary.
		await expect(page.getByText(MOCK_REPLY).first()).toBeVisible();
	});
});
