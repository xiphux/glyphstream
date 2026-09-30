import { test, expect, type APIRequestContext, type Page } from './fixtures/test';
import { resetData, selectModel } from './helpers';

/**
 * Pausing an endpoint's queue, end to end: the admin toggle on
 * /settings/endpoints, the banner, a generation holding as "Paused" in the chat
 * while it waits, and resuming it from the settings page.
 *
 * The pause is server-wide, held in the running server's memory AND saved in
 * the database (so it would even outlive a server restart), and `resetData()`
 * clears neither — a pause left behind by a failing test would stall every
 * image generation in the suite after it. So every test starts and ends
 * by resuming through the API, whatever happened in between.
 */

async function resumeMock(request: APIRequestContext) {
	// The API's CSRF gate trusts Fetch Metadata; the browser sets it, this client
	// doesn't, so say what a same-origin fetch would.
	const res = await request.delete('/api/admin/endpoints/mock/pause', {
		headers: { 'Sec-Fetch-Site': 'same-origin' },
	});
	expect(res.ok()).toBe(true);
}

/** Send an image prompt from home WITHOUT waiting for the image, which a paused
 *  queue is not going to produce. */
async function sendImage(page: Page, prompt: string) {
	await page.goto('/');
	await expect(page.getByRole('button', { name: 'Select model' })).toContainText('Mock Chat');
	await selectModel(page, /Mock Image/);
	await page.locator('textarea').first().fill(prompt);
	await page.getByRole('button', { name: 'Send message' }).click();
	await page.waitForURL(/\/chat\/[^/]+$/);
}

test.beforeEach(async ({ request }) => {
	resetData();
	await resumeMock(request);
});

test.afterEach(async ({ request }) => {
	await resumeMock(request);
});

test.describe('endpoint pause', () => {
	test('pauses from the settings page, holds a generation, and resumes it', async ({
		page,
		context,
	}) => {
		// Pause from the endpoints page. Idle, so the banner says it's safe to
		// restart the backend.
		const settings = await context.newPage();
		await settings.goto('/settings/endpoints');
		await settings.getByRole('button', { name: 'Pause' }).click();
		await expect(settings.getByText(/Queue paused — nothing is running/)).toBeVisible();
		await expect(settings.getByRole('button', { name: 'Resume' })).toBeVisible();

		// An image sent now waits, and says why.
		await sendImage(page, 'a lighthouse at dusk');
		await expect(page.getByText('Paused', { exact: true })).toBeVisible();
		await expect(page.locator('img[src*="/api/media/"]')).toHaveCount(0);

		// The settings page lists it in line. It learns of it from its 3s poll, so
		// allow a couple of polls rather than the default 5s, which leaves a slow
		// runner little headroom.
		await expect(settings.getByText(/^waiting /)).toBeVisible({ timeout: 10_000 });

		// Resume → the held generation runs and lands in the chat that's still open.
		await settings.getByRole('button', { name: 'Resume' }).click();
		await expect(settings.getByRole('button', { name: 'Pause' })).toBeVisible();
		await expect(page.locator('img[src*="/api/media/"]').first()).toBeVisible();
		await expect(page.getByText('Paused', { exact: true })).toHaveCount(0);
	});

	test('keeps the pause across a reload of the settings page', async ({ page }) => {
		await page.goto('/settings/endpoints');
		await page.getByRole('button', { name: 'Pause' }).click();
		await expect(page.getByRole('button', { name: 'Resume' })).toBeVisible();

		await page.reload();
		await expect(page.getByText(/Queue paused/)).toBeVisible();
		await expect(page.getByRole('button', { name: 'Resume' })).toBeVisible();
	});
});
