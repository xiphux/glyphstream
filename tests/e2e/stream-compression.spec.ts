/**
 * A streamed reply is gzipped (`maybeCompressStream`, on by default) and still
 * streams: each word reaches the page as it's generated, not all at once when
 * the reply ends. The unit test proves the bytes are flushed per frame; this
 * proves the whole path — hook, relay, the browser's decoder and the chat
 * page's reader — keeps it incremental.
 */
import { test, expect } from './fixtures/test';
import { MOCK_REPLY, resetData, selectModel } from './helpers';

test.beforeEach(() => resetData());

test('a streamed reply arrives gzipped and word by word', async ({ page }) => {
	await page.goto('/');
	await expect(page.getByRole('button', { name: 'Select model' })).toContainText('Mock Chat');
	await selectModel(page, /^Mock Chat Slow$/);

	const stream = page.waitForResponse((r) =>
		(r.headers()['content-type'] ?? '').startsWith('text/event-stream'),
	);
	await page.locator('textarea').first().fill('Say hello slowly');
	const send = page.getByRole('button', { name: 'Send message' });
	await expect(send).toBeEnabled();
	await send.click();
	expect((await stream).headers()['content-encoding']).toBe('gzip');

	// Mock Chat Slow sends a word every 250ms. Part of the reply on screen while
	// the rest is still to come means it streamed.
	await expect(page.getByText(/^Hello from/)).toBeVisible();
	await expect(page.getByText(MOCK_REPLY)).toHaveCount(0);
	await expect(page.getByText(MOCK_REPLY)).toBeVisible();
	await expect(send).toBeVisible();
});
