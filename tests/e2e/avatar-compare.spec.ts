import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test, expect, type Page } from './fixtures/test';
import { resetData, sendChatFromHome } from './helpers';

/**
 * Drawing a conversation avatar, with one image model or several, and picking
 * the one to keep.
 *
 * What only an e2e can say here. The unit tests mock every boundary this flow
 * crosses: the endpoint tests mock the job runner, the workflow tests mock
 * fetch. So each half is pinned and the seam between them isn't — a portrait
 * is drawn by a durable job, lands as a version on the reply it was drawn from
 * (`message_images`), becomes the face server-side, and reaches the page
 * through the light photo read rather than a reload. Nothing below stubs any
 * of it.
 *
 * Uses Mock Image + Mock Painter (mock-upstream.mjs). Both return the same 1x1
 * PNG instantly, so draws settle immediately.
 */

const DB_PATH = resolve('./tests/.e2e-data/test.db');

function query<T>(sql: string, ...params: string[]): T {
	const db = new DatabaseSync(DB_PATH);
	db.exec('PRAGMA busy_timeout = 5000');
	try {
		return db.prepare(sql).get(...params) as T;
	} finally {
		db.close();
	}
}

const face = (convId: string) =>
	query<{ avatar_media_id: string | null }>(
		'SELECT avatar_media_id FROM conversations WHERE id = ?',
		convId,
	).avatar_media_id;
const portraitCount = (convId: string) =>
	query<{ n: number }>(
		`SELECT COUNT(*) AS n FROM message_images
		 WHERE conversation_id = ? AND kind = 'portrait' AND media_id IS NOT NULL`,
		convId,
	).n;
const messageCount = (convId: string) =>
	query<{ n: number }>('SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ?', convId).n;

const avatarMenu = (page: Page) =>
	page.getByRole('button', { name: /^Avatar for this conversation/ });
const headerFace = (page: Page) => page.locator('header img[src*="/api/media/"]').first();

async function openDrawDialog(page: Page) {
	await avatarMenu(page).click();
	await page.getByRole('button', { name: /Draw the latest reply|Draw it again/ }).click();
	const dialog = page.getByRole('dialog', { name: 'Draw the avatar' });
	await expect(dialog).toBeVisible();
	return dialog;
}

test.beforeEach(() => resetData());

test.describe('flow: drawing the avatar', () => {
	test('draws a portrait onto the reply and wears it, leaving the thread alone', async ({
		page,
	}) => {
		const convId = await sendChatFromHome(page, 'Describe how you look');
		await expect(page.locator('header img[src*="/api/media/"]')).toHaveCount(0);
		const before = messageCount(convId);

		const dialog = await openDrawDialog(page);
		await dialog.getByRole('button', { name: 'Draw', exact: true }).click();

		// The dialog closes once the server has it, and the portrait shows at the
		// end of the reply it was drawn from.
		await expect(dialog).toBeHidden();
		await expect(page.getByRole('button', { name: 'Open portrait' })).toBeVisible({
			timeout: 15_000,
		});
		await expect(headerFace(page)).toBeVisible();

		expect(face(convId)).not.toBeNull();
		expect(portraitCount(convId)).toBe(1);
		// No message of its own: the thread holds only the conversation.
		expect(messageCount(convId)).toBe(before);
	});

	test('compares models in the dialog and wears the one picked', async ({ page }) => {
		const convId = await sendChatFromHome(page, 'Describe how you look');
		const dialog = await openDrawDialog(page);

		// "Multiple" seeds the cart with the model already selected, so one more
		// click makes it a comparison. The dropdown is portalled to the body.
		await dialog.getByLabel('Select model').click();
		await page.getByRole('button', { name: 'Multiple' }).click();
		await page.getByRole('option', { name: /^Mock Painter/ }).click();
		// Toggle the picker shut rather than pressing Escape, which would also
		// close the dialog.
		await dialog.getByLabel('Select model').click();
		await dialog.getByRole('button', { name: 'Draw with 2 models' }).click();

		// The dialog stays up and becomes the comparison.
		const pick = dialog.getByRole('button', { name: 'Use this avatar' });
		await expect(pick).toHaveCount(2, { timeout: 15_000 });
		await expect(pick.nth(1)).toBeEnabled({ timeout: 15_000 });
		await pick.nth(1).click();

		await expect(dialog).toBeHidden();
		await expect(headerFace(page)).toBeVisible();
		const picked = face(convId);
		expect(picked).not.toBeNull();
		// Both kept, as versions: the arrows on the portrait reach the other.
		expect(portraitCount(convId)).toBe(2);
		await expect(page.getByText('2/2').or(page.getByText('1/2'))).toBeVisible();

		// Switching versions changes the face.
		const other = page.getByRole('button', { name: /Previous version|Next version/ });
		await other.and(page.locator(':enabled')).first().click();
		await expect.poll(() => face(convId)).not.toBe(picked);
	});

	test('keeps a comparison whose streams were lost, and picks from it full size', async ({
		page,
	}) => {
		const convId = await sendChatFromHome(page, 'Describe how you look');
		// Each draw is handed to the server, and its stream then ends before the
		// server says anything — as an iOS PWA's connections go when it's
		// suspended. The photo state can't be read either, until `reachable`.
		let reachable = false;
		await page.route(
			(url) => url.pathname === `/api/conversations/${convId}/photos`,
			async (route) => {
				const request = route.request();
				if (request.method() !== 'POST') {
					if (reachable) await route.fallback();
					else await route.abort();
					return;
				}
				const headers = await request.allHeaders();
				const sent = new AbortController();
				const res = await fetch(request.url(), {
					method: 'POST',
					headers: {
						cookie: headers.cookie,
						origin: headers.origin,
						'content-type': headers['content-type'],
					},
					body: request.postData(),
					signal: sent.signal,
				});
				sent.abort();
				await route.fulfill({ status: res.status, contentType: 'text/event-stream', body: '' });
			},
		);

		const dialog = await openDrawDialog(page);
		// Slow enough to still be drawing once the streams are gone
		// (mock-upstream's SLOW_DRAW), and sent as written so the marker reaches
		// the image model.
		await dialog.getByLabel('Image prompt').fill('SLOW_DRAW a red fox');
		await dialog.getByLabel(/Rewrite for this model/).setChecked(false);
		await dialog.getByLabel('Select model').click();
		await page.getByRole('button', { name: 'Multiple' }).click();
		await page.getByRole('option', { name: /^Mock Painter/ }).click();
		await dialog.getByLabel('Select model').click();
		await dialog.getByRole('button', { name: 'Draw with 2 models' }).click();

		// Both streams are gone and the server can't be asked: the tab's own
		// count of the draws keeps them on screen.
		await expect
			.poll(
				() =>
					query<{ n: number }>(
						'SELECT COUNT(*) AS n FROM generation_jobs WHERE conversation_id = ?',
						convId,
					).n,
			)
			.toBe(2);
		await page.waitForTimeout(500);
		await expect(dialog.getByText('Developing…')).toHaveCount(2);

		// Reachable again: the develop watch asks, and the results land in the grid.
		reachable = true;
		const pick = dialog.getByRole('button', { name: 'Use this avatar' });
		await expect(pick).toHaveCount(2, { timeout: 15_000 });
		await expect(dialog.getByText('Developing…')).toHaveCount(0);

		// Closed without a pick, the comparison is still open: the full-size view
		// offers its pick, which counts as the grid's would.
		await dialog.getByRole('button', { name: 'Done' }).click();
		await expect(dialog).toBeHidden();
		await page.getByRole('button', { name: 'Open portrait' }).click();
		const lightboxPick = page.getByRole('button', { name: 'Use this avatar' });
		await expect(lightboxPick).toBeVisible();
		await lightboxPick.click();
		await expect
			.poll(
				() =>
					query<{ n: number }>(
						`SELECT COUNT(*) AS n FROM message_images
						 WHERE conversation_id = ? AND comparison_id IS NOT NULL`,
						convId,
					).n,
			)
			.toBe(0);
		expect(face(convId)).not.toBeNull();
	});
});
