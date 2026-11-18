import { test, expect, type Page } from './fixtures/test';
import { MOCK_REPLY, resetData } from './helpers';

/**
 * Attaching a file from the composer, end to end: the picker hands the file to
 * the attachment store, `/api/uploads` stores it, the message carries it, and
 * the thread renders it from the media routes. Each half is unit-tested; this
 * is the only place the picker, the upload and the rendered bubble meet.
 */

test.beforeEach(() => resetData());

/** A real, decodable 1x1 PNG — the server thumbnails uploads with sharp. */
const PNG_1X1 = Buffer.from(
	'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADUlEQVQI12OosXr7HwAFfAKjosON1QAAAABJRU5ErkJggg==',
	'base64',
);

async function openHome(page: Page): Promise<void> {
	await page.goto('/');
	await expect(page.getByRole('button', { name: 'Select model' })).toContainText('Mock Chat');
}

/** The composer's hidden file input, which the "Attach file" button clicks. */
const fileInput = (page: Page) => page.locator('input[type="file"]').first();

test.describe('composer attachments', () => {
	test('an attached image uploads, sends, and renders in the user bubble', async ({ page }) => {
		await openHome(page);
		const uploaded = page.waitForResponse(
			(r) => r.url().endsWith('/api/uploads') && r.request().method() === 'POST',
		);
		await fileInput(page).setInputFiles({
			name: 'dot.png',
			mimeType: 'image/png',
			buffer: PNG_1X1,
		});
		expect((await uploaded).status()).toBe(200);
		// The composer's local preview, before anything is sent.
		await expect(page.locator('img[src^="blob:"]')).toBeVisible();

		await page.locator('textarea').first().fill('what is in this picture?');
		const send = page.getByRole('button', { name: 'Send message' });
		await expect(send).toBeEnabled();
		await send.click();
		await page.waitForURL(/\/chat\/[^/]+$/);
		await expect(page.getByText(MOCK_REPLY)).toBeVisible();
		await expect(send).toBeVisible();

		const image = page.locator('[id^="msg-"]').first().locator('img[src*="/api/media/"]');
		await expect(image).toBeVisible();
		const src = await image.getAttribute('src');
		expect(src).toMatch(/^\/api\/media\/[^/]+\/display$/);
		const res = await page.request.get(src!);
		expect(res.status()).toBe(200);
	});

	test('a refused file type shows an error chip and blocks Send until removed', async ({
		page,
	}) => {
		await openHome(page);
		await page.locator('textarea').first().fill('run this');
		const refused = page.waitForResponse(
			(r) => r.url().endsWith('/api/uploads') && r.request().method() === 'POST',
		);
		await fileInput(page).setInputFiles({
			name: 'tool.exe',
			mimeType: 'application/x-msdownload',
			buffer: Buffer.from('MZ not really a program'),
		});
		expect((await refused).status()).toBe(415);

		const chip = page.locator('[title^="Unsupported content type"]');
		await expect(chip).toBeVisible();
		await expect(chip).toContainText('tool.exe');
		await expect(chip.locator('.text-danger')).toBeVisible();
		const send = page.getByRole('button', { name: 'Send message' });
		await expect(send).toBeDisabled();

		await chip.getByRole('button', { name: 'Remove attachment' }).click();
		await expect(chip).toHaveCount(0);
		await expect(send).toBeEnabled();
	});
});
