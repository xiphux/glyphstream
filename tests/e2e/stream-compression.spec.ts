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

/**
 * The launch-time probe (`#lib/stream-probe.ts`): a client whose network held
 * compressed streams back carries `gs-stream-gzip=0`, and its streams go out
 * uncompressed; a later launch that streams fine clears it.
 */
test.describe('the per-client stream probe', () => {
	const optOut = (url: string) => ({
		name: 'gs-stream-gzip',
		value: '0',
		url: new URL('/', url).toString(),
	});

	test('a client opted out gets its streams uncompressed', async ({ page, context, baseURL }) => {
		// Keep this launch's probe from passing and clearing the opt-out first.
		await page.route('**/api/stream-probe', (route) => route.abort());
		await context.addCookies([optOut(baseURL!)]);
		await page.goto('/');
		await expect(page.getByRole('button', { name: 'Select model' })).toContainText('Mock Chat');

		const stream = page.waitForResponse((r) =>
			(r.headers()['content-type'] ?? '').startsWith('text/event-stream'),
		);
		await page.locator('textarea').first().fill('Hello');
		await page.getByRole('button', { name: 'Send message' }).click();
		expect((await stream).headers()['content-encoding']).toBeUndefined();
		await expect(page.getByText(MOCK_REPLY)).toBeVisible();
		await expect(page.getByRole('button', { name: 'Send message' })).toBeVisible();
	});

	test('a launch whose probe streams clears an old opt-out', async ({ page, context, baseURL }) => {
		await context.addCookies([optOut(baseURL!)]);
		const probe = page.waitForResponse((r) => r.url().endsWith('/api/stream-probe'));
		await page.goto('/');
		// Compressed even with the opt-out set: the probe has to keep testing.
		expect((await probe).headers()['content-encoding']).toBe('gzip');
		await expect
			.poll(async () => (await context.cookies()).find((c) => c.name === 'gs-stream-gzip')?.value)
			.not.toBe('0');
	});
});
