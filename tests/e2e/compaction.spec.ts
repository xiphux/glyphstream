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
 * The pure token math / cut / worthwhile logic is unit-tested; these specs pin
 * the browser wiring the unit layer can't: the Compact button gating, the
 * streamed summary settling into a collapsed divider with the real messages
 * still inline, and auto-compaction firing on a send before the reply.
 *
 * Messages are deliberately large: the worthwhile guard only enables/fires
 * compaction once the *foldable history* clears ~1000 tokens, so a handful of
 * one-word turns would (correctly) never become compactable. `big(marker)`
 * gives ~1.3k tokens per turn with a findable marker.
 */

const COMPACT = /compact|summariz/i; // icon-only button in the budget bar (aria-label/title)
const SUMMARY_DIVIDER = /Context summary/;
const big = (marker: string) => `${marker}: ` + 'lorem ipsum dolor sit amet '.repeat(200);

test.describe('manual compaction', () => {
	test('Compact is gated until the history is worth folding, then folds it into a summary', async ({
		page,
	}) => {
		await sendChatFromHome(page, big('alpha')); // turn 1 (Mock Chat)

		// Structurally too short AND not worth it yet.
		const compact = page.getByRole('button', { name: COMPACT });
		await expect(compact).toBeDisabled();

		await sendFollowup(page, big('beta')); // turn 2
		await sendFollowup(page, big('gamma')); // turn 3 → folds turn 1 (~1.3k tokens)

		await expect(compact).toBeEnabled();
		await compact.click();

		// The summary lands as a collapsed divider, the real turns stay inline.
		// Scope marker text to the message body (it also appears as the title /
		// sidebar link, which would be a strict-mode multi-match).
		const divider = page.getByRole('button', { name: SUMMARY_DIVIDER });
		await expect(divider).toBeVisible();
		await expect(page.locator('div.whitespace-pre-wrap', { hasText: 'alpha' })).toBeVisible();
		await expect(page.locator('div.whitespace-pre-wrap', { hasText: 'gamma' })).toBeVisible();

		// A success toast confirms the action even though the divider lands up-thread.
		await expect(page.getByText('Conversation compacted')).toBeVisible();

		// Collapsed by default; expands to reveal the generated summary.
		await expect(page.getByText('MOCK SUMMARY')).toBeHidden();
		await divider.click();
		await expect(page.getByText('MOCK SUMMARY')).toBeVisible();
	});

	test('a compaction can be undone — from the toast, and from the divider', async ({ page }) => {
		await sendChatFromHome(page, big('alpha'));
		await sendFollowup(page, big('beta'));
		await sendFollowup(page, big('gamma'));

		const compact = page.getByRole('button', { name: COMPACT });
		const divider = page.getByRole('button', { name: SUMMARY_DIVIDER });

		// Compact, then Undo straight from the success toast (the accidental-tap
		// path): the divider vanishes and the originals are all back inline.
		await expect(compact).toBeEnabled();
		await compact.click();
		await expect(divider).toBeVisible();
		await page.getByRole('button', { name: 'Undo', exact: true }).click();
		await expect(divider).toHaveCount(0);
		await expect(page.locator('div.whitespace-pre-wrap', { hasText: 'alpha' })).toBeVisible();

		// Re-compact, then Undo from the divider's own control (expand → restore).
		await expect(compact).toBeEnabled();
		await compact.click();
		await expect(divider).toBeVisible();
		// Dismiss/await past the toast so its Undo can't be the one we click.
		await page.getByText('Conversation compacted').waitFor({ state: 'hidden' });
		await divider.click();
		await page.getByRole('button', { name: /undo compaction/i }).click();
		await expect(divider).toHaveCount(0);
	});
});

test.describe('auto-compaction', () => {
	test('fires on a send once the thread crosses the threshold, before the reply', async ({
		page,
	}) => {
		// 10% of the tiny model's 50-token window = 5 tokens; every real reply
		// reports 18, so any thread that's also worth compacting is over the line.
		setAutoCompaction(true, 10);

		await page.goto('/');
		await selectModel(page, 'Mock Chat Tiny');

		// Turn 1 from the home composer.
		await page.locator('textarea').first().fill(big('one'));
		const send = page.getByRole('button', { name: 'Send message' });
		await expect(send).toBeEnabled();
		await send.click();
		await page.waitForURL(/\/chat\/[^/]+$/);
		await expect(page.getByText(MOCK_REPLY).first()).toBeVisible();
		await expect(send).toBeVisible();

		await sendFollowup(page, big('two'));
		await sendFollowup(page, big('three'));

		// No compaction yet — nobody clicked Compact.
		await expect(page.getByRole('button', { name: SUMMARY_DIVIDER })).toHaveCount(0);

		// The next send auto-compacts first (no Compact click), then replies.
		await sendFollowup(page, big('four'));
		await expect(page.getByRole('button', { name: SUMMARY_DIVIDER })).toHaveCount(1);
		// The reply still arrived after the summary.
		await expect(page.getByText(MOCK_REPLY).first()).toBeVisible();
	});

	test('a failed auto-compaction asks before sending — Cancel keeps the draft, Send anyway proceeds', async ({
		page,
	}) => {
		setAutoCompaction(true, 10);

		await page.goto('/');
		await selectModel(page, 'Mock Chat Tiny');

		// Turn 1 carries the sentinel that forces a blank summary; it's an early
		// turn, so it lands in the folded slice the summarizer sees.
		await page
			.locator('textarea')
			.first()
			.fill(big('one') + ' FORCE_EMPTY_SUMMARY');
		const send = page.getByRole('button', { name: 'Send message' });
		await expect(send).toBeEnabled();
		await send.click();
		await page.waitForURL(/\/chat\/[^/]+$/);
		await expect(page.getByText(MOCK_REPLY).first()).toBeVisible();

		await sendFollowup(page, big('two'));
		await sendFollowup(page, big('three'));

		const bubbles = page.locator('[id^="msg-"]');
		const beforeCount = await bubbles.count();

		// The triggering send auto-compacts first, which fails (blank summary).
		// sendFollowup can't be used — the message is held behind the dialog, so
		// the bubble count doesn't advance yet.
		const draft = big('four');
		await page.locator('textarea').first().fill(draft);
		await send.click();

		const dialog = page.getByRole('alertdialog');
		await expect(dialog.getByRole('button', { name: 'Send anyway' })).toBeVisible();

		// Cancel: nothing was sent, the summary never landed, and — the fix — the
		// typed message is still in the composer rather than silently eaten.
		await dialog.getByRole('button', { name: 'Cancel' }).click();
		await expect(dialog).toBeHidden();
		await expect(page.locator('textarea').first()).toHaveValue(draft);
		await expect(bubbles).toHaveCount(beforeCount);
		await expect(page.getByRole('button', { name: SUMMARY_DIVIDER })).toHaveCount(0);

		// Retry from the preserved draft and choose Send anyway: it goes out with
		// the full (un-compacted) context — reply arrives, still no summary.
		await send.click();
		await expect(dialog.getByRole('button', { name: 'Send anyway' })).toBeVisible();
		await dialog.getByRole('button', { name: 'Send anyway' }).click();
		await expect(bubbles).toHaveCount(beforeCount + 2);
		await expect(page.getByRole('button', { name: SUMMARY_DIVIDER })).toHaveCount(0);
	});
});
