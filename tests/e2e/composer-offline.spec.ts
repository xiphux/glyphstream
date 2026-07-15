import { test, expect } from '@playwright/test';
import { MOCK_REPLY, resetData, sendChatFromHome, sendFollowup } from './helpers';

// Clean slate before each flow (shared DB across projects — see resetData).
test.beforeEach(() => resetData());

/**
 * Composer offline gating (Option-1 offline handling). While the browser
 * reports no network we BLOCK sending rather than queueing — Send disables, an
 * inline notice shows, and the typed message stays in the box (and its draft)
 * instead of clearing into a doomed "Load failed". The button-disabled +
 * notice contract is unit-tested on ComposerCore's wrapper; these e2e cases
 * lock in what unit tests can't reach: the real navigator.onLine + window
 * offline/online events driving page state, the send-handler guard that keeps
 * an Enter-submit from clearing the box, and Send re-enabling on reconnect.
 * The wiring spans both route files plus the shared composer.
 *
 * `context.setOffline` both kills in-flight connections and fires the window
 * `offline`/`online` events (the same seam events.spec.ts relies on).
 */

const draftKey = (id: string | null) => `glyphstream:composerDraft:${id ?? 'new'}`;
const readDraft = (page: import('@playwright/test').Page, id: string | null) =>
	page.evaluate((k) => localStorage.getItem(k), draftKey(id));

test.describe('composer offline gating: new-chat box', () => {
	test('offline disables Send + shows the notice + keeps the prompt; reconnect sends it', async ({
		page,
		context,
	}) => {
		await page.goto('/');
		// Gate on hydration + default-model selection (composer interactive).
		await expect(page.getByRole('button', { name: 'Select model' })).toContainText('Mock Chat');

		const prompt = 'Prompt typed just before walking into a dead zone';
		const composer = page.locator('textarea').first();
		await composer.fill(prompt);

		const send = page.getByRole('button', { name: 'Send message' });
		await expect(send).toBeEnabled();

		// Go offline: Send disables, the notice appears, the text stays put.
		await context.setOffline(true);
		await expect(send).toBeDisabled();
		await expect(page.getByText(/you're offline/i)).toBeVisible();
		await expect(composer).toHaveValue(prompt);

		// Enter while offline must NOT clear the box or navigate — the send
		// handler bails before anything is cleared (the lossy-path guard).
		await composer.press('Enter');
		await expect(page).toHaveURL(/\/$/);
		await expect(composer).toHaveValue(prompt);

		// Back online: the notice clears, Send re-enables, the prompt sends.
		await context.setOffline(false);
		await expect(page.getByText(/you're offline/i)).toHaveCount(0);
		await expect(send).toBeEnabled();
		await send.click();
		await page.waitForURL(/\/chat\/[^/]+$/);
		await expect(page.getByText(MOCK_REPLY)).toBeVisible();
		// Gate on the turn fully settling (composer flips Stop → Send) before the
		// test ends — the relay emits `done` only after its recorder has persisted
		// the assistant row, so this keeps the next test's resetData() from
		// deleting the conversation mid-insert (FK-constraint error server-side).
		await expect(page.getByRole('button', { name: 'Send message' })).toBeVisible();
	});
});

test.describe('composer offline gating: existing conversation', () => {
	test('an offline follow-up is blocked + preserved (box + draft); reconnect sends it', async ({
		page,
		context,
	}) => {
		const convId = await sendChatFromHome(page, 'Offline follow-up conversation');

		const followup = 'Unsent follow-up typed while offline';
		const composer = page.locator('textarea').first();
		await composer.fill(followup);
		await expect.poll(() => readDraft(page, convId)).toContain(followup);

		const send = page.getByRole('button', { name: 'Send message' });
		await expect(send).toBeEnabled();

		await context.setOffline(true);
		await expect(send).toBeDisabled();
		await expect(page.getByText(/you're offline/i)).toBeVisible();

		// Enter is swallowed; the message + its persisted draft both survive.
		await composer.press('Enter');
		await expect(composer).toHaveValue(followup);
		await expect.poll(() => readDraft(page, convId)).toContain(followup);

		// Reconnect and send for real — the draft clears on the successful send.
		await context.setOffline(false);
		await expect(send).toBeEnabled();
		await sendFollowup(page, followup);
		await expect.poll(() => readDraft(page, convId)).toBeNull();
	});
});
