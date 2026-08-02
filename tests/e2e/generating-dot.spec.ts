import { test, expect, type Page } from '@playwright/test';
import { MOCK_REPLY, openSidebar, resetData, selectModel, sendChatFromHome } from './helpers';

/**
 * The sidebar's generating dot — the client wiring no unit test can reach: a
 * Svelte flag that must SURVIVE navigating away from the thread it belongs to
 * (that's the whole feature — the conversation you left is the one you can't
 * otherwise see finish), a server-seeded copy that must survive a reload, and
 * a poll that must eventually take the dot back off.
 *
 * The three sources are asserted separately because they fail independently:
 * an effect-ordering slip in the chat page clears the flag on the way out, a
 * missing `generatingIds` in the layout load loses it on reload, and a broken
 * reconcile leaves the dot burning forever.
 *
 * Timing: prompts carry mock-upstream's GLACIAL_MARKER so the reply takes ~8s
 * — long enough to outlast a full page load and the poll's first tick, which
 * `Mock Chat Slow` on its own (~2s) is not.
 */

test.beforeEach(() => resetData());

/** The row-level dot for a conversation, addressed through its sidebar link so
 *  a dot on some *other* row can never satisfy the assertion. */
function dotFor(page: Page, convId: string) {
	return page.locator(`a[href="/chat/${convId}"]`).getByRole('img', { name: /Generating/ });
}

/** Start a deliberately-slow turn in the currently-open conversation and wait
 *  until it's genuinely streaming (composer showing Stop). */
async function startGlacialTurn(page: Page): Promise<void> {
	await selectModel(page, /^Mock Chat Slow$/);
	await page.locator('textarea').first().fill('GLACIAL_STREAM keep talking');
	const send = page.getByRole('button', { name: 'Send message' });
	await expect(send).toBeEnabled();
	await send.click();
	await expect(page.getByRole('button', { name: 'Stop generation' })).toBeVisible();
}

/** Let the in-flight turn finish before the test ends, so the next test's
 *  resetData() doesn't race the server-side recorder still inserting rows
 *  (the FK-constraint race helpers.ts warns about). */
async function settle(page: Page): Promise<void> {
	await expect(page.getByRole('button', { name: 'Send message' })).toBeVisible({ timeout: 20_000 });
}

test('dot marks the conversation left generating, and clears once it finishes', async ({
	page,
	isMobile,
}) => {
	const other = await sendChatFromHome(page, 'Somewhere else to go');
	const generating = await sendChatFromHome(page, 'The slow one');

	await startGlacialTurn(page);
	// Shows on the active row too — the dot is about the conversation, not about
	// where you happen to be standing.
	await openSidebar(page, isMobile);
	await expect(dotFor(page, generating)).toBeVisible();

	// Navigate away. The chat page aborts its local fetch on the way out and the
	// server keeps generating, so this is exactly the moment the flag has to
	// survive: it's published from the same signal that gets torn down here.
	await page.locator(`a[href="/chat/${other}"]`).click();
	await page.waitForURL(`**/chat/${other}`);
	await openSidebar(page, isMobile);
	await expect(dotFor(page, generating)).toBeVisible();
	// ...and only on that row. The conversation we switched TO is idle, so the
	// switch must not have re-pointed the flag at it.
	await expect(dotFor(page, other)).toHaveCount(0);

	// Nothing local is listening to that generation any more — the layout's poll
	// is the only thing that can retire the dot. Generous window: the reply runs
	// ~8s and the poll ticks every 5s.
	await expect(dotFor(page, generating)).toHaveCount(0, { timeout: 25_000 });
});

test('dot survives a full page load, seeded from the server registry', async ({
	page,
	isMobile,
}) => {
	const other = await sendChatFromHome(page, 'Reload destination');
	const generating = await sendChatFromHome(page, 'Reload subject');

	await startGlacialTurn(page);

	// A hard load into a DIFFERENT conversation: the in-memory flag set is gone,
	// so a dot here can only have come from the layout load's `generatingIds`
	// (the server's in-flight registry).
	await page.goto(`/chat/${other}`);
	await expect(page.getByRole('button', { name: 'Select model' })).toBeVisible();
	await openSidebar(page, isMobile);
	await expect(dotFor(page, generating)).toBeVisible();

	await page.goto(`/chat/${generating}`);
	await expect(page.getByText(MOCK_REPLY)).toBeVisible({ timeout: 20_000 });
	await settle(page);
});

test('no dot on an idle conversation', async ({ page, isMobile }) => {
	// Guards the other direction: a settled conversation must not keep a dot
	// (a leaked flag would be indistinguishable from a stuck generation).
	const convId = await sendChatFromHome(page, 'Idle and quiet');
	await openSidebar(page, isMobile);
	await expect(page.locator(`a[href="/chat/${convId}"]`)).toBeVisible();
	await expect(dotFor(page, convId)).toHaveCount(0);
});
