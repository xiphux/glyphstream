import { test, expect, type Page } from './fixtures/test';
import { MOCK_REPLY, resetData, sendFollowup } from './helpers';

/**
 * An upstream that fails the turn, end to end: a 500 before any SSE, and a
 * connection cut partway through the stream. The relay and the turn controller
 * each have unit tests for both; what only a browser shows is the page wiring —
 * that the failure is on screen, the composer comes back, and what the server
 * kept of the turn is still there after a reload.
 *
 * The failures are planted by prompt markers the mock upstream reads
 * (tests/e2e/fixtures/mock-upstream.mjs) from the latest user message only, so a
 * follow-up in the same thread streams normally.
 */

test.beforeEach(() => resetData());

/** Send `prompt` from home and wait for the thread's URL. */
async function sendFromHome(page: Page, prompt: string): Promise<void> {
	await page.goto('/');
	await expect(page.getByRole('button', { name: 'Select model' })).toContainText('Mock Chat');
	await page.locator('textarea').first().fill(prompt);
	const send = page.getByRole('button', { name: 'Send message' });
	await expect(send).toBeEnabled();
	await send.click();
	await page.waitForURL(/\/chat\/[^/]+$/);
}

/** The assistant's slot in the thread: the last message article. */
const lastBubble = (page: Page) => page.locator('[id^="msg-"]').last();

test.describe('an upstream failure', () => {
	test('a 500 shows the error, frees the composer, and leaves an error row', async ({ page }) => {
		await sendFromHome(page, 'FORCE_UPSTREAM_500 hello');

		// Live, the failure is the composer's banner, carrying the upstream's text.
		await expect(page.getByText(/returned HTTP 500.*forced failure/)).toBeVisible();
		await expect(page.getByRole('button', { name: 'Send message' })).toBeVisible();

		// After a reload it is the persisted error row in the reply's slot.
		await page.reload();
		await expect(lastBubble(page).locator('.text-danger')).toContainText('forced failure');

		// The thread is still usable: a follow-up streams a normal reply.
		await sendFollowup(page, 'try again');
		await expect(lastBubble(page)).toContainText(MOCK_REPLY);
	});

	test('a dropped stream shows the error, frees the composer, and keeps what arrived', async ({
		page,
	}) => {
		await sendFromHome(page, 'DROP_MID_STREAM hello');

		// The mock sends two words before it cuts the connection.
		const partial = MOCK_REPLY.split(' ').slice(0, 2).join(' ');
		await expect(page.getByRole('button', { name: 'Send message' })).toBeVisible();
		await expect(lastBubble(page)).toContainText(partial);
		await expect(lastBubble(page).locator('.text-danger')).toContainText('Upstream stream failed');

		// The partial text and the failure are one persisted row.
		await page.reload();
		await expect(lastBubble(page)).toContainText(partial);
		await expect(lastBubble(page)).not.toContainText(MOCK_REPLY);
		await expect(lastBubble(page).locator('.text-danger')).toContainText('Upstream stream failed');
	});
});
