import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test, expect, type Page } from '@playwright/test';
import { resetData, sendChatFromHome } from './helpers';

/**
 * Drawing a conversation avatar with several image models at once, and picking
 * the one to keep.
 *
 * What only an e2e can say here. The unit tests mock every boundary this flow
 * crosses: the endpoint tests mock the relay and the queries, the controller
 * tests mock fetch. So each half is pinned and the seam between them isn't —
 * and the seam is where this feature actually lives. A comparison PARKS itself
 * (the fan-out marker on the appearance description, the active leaf moved onto
 * it), which is a claim about how the branch walk, the recovery rebuild and the
 * pick interact against a real database. Nothing below stubs any of it.
 *
 * Two specs:
 *   - happy path: two image models draw candidate portraits into the compare
 *     grid; "Use this face" adopts one, moves the thread onto its branch, and
 *     leaves the other reachable as a sibling.
 *   - recovery: reload with the comparison still unresolved. The grid has to
 *     come back from server truth AND come back as an AVATAR comparison — the
 *     `avatar` flag is what keeps its pick adopting a face rather than
 *     continuing the chat with an image model, and a reloaded page has nothing
 *     else to tell the two apart.
 *
 * Uses Mock Image + Mock Painter (mock-upstream.mjs). Both return the same 1x1
 * PNG instantly, so the columns settle immediately — the timing-sensitive half
 * of fan-out recovery is fanout.spec.ts's job, not this file's.
 */

const DB_PATH = resolve('./tests/.e2e-data/test.db');

/** Read the columns this flow is a claim about, straight from the DB. */
function conversationRow(id: string): {
	avatar_media_id: string | null;
	active_leaf_message_id: string | null;
	fanout_parent_message_id: string | null;
} {
	const db = new DatabaseSync(DB_PATH);
	db.exec('PRAGMA busy_timeout = 5000');
	try {
		return db
			.prepare(
				`SELECT avatar_media_id, active_leaf_message_id, fanout_parent_message_id
				 FROM conversations WHERE id = ?`,
			)
			.get(id) as ReturnType<typeof conversationRow>;
	} finally {
		db.close();
	}
}

const avatarMenu = (page: Page) =>
	page.getByRole('button', { name: /^Avatar for this conversation/ });

/**
 * From a conversation whose latest reply is the appearance description, open
 * the draw dialog and dispatch a comparison across both mock image models.
 */
async function drawWithTwoModels(page: Page): Promise<void> {
	await avatarMenu(page).click();
	await page.getByRole('button', { name: /Draw the latest reply|Draw it again/ }).click();

	// The dialog's picker is filtered to image models. "Multiple" seeds the cart
	// with the one already selected, so one more click makes it a comparison.
	// Scoped to the dialog: the composer behind it has a picker too, and only the
	// TRIGGER is inside — bits-ui portals the dropdown itself to the body, so the
	// clicks below stay at page level.
	const dialog = page.getByRole('dialog', { name: 'Draw the avatar' });
	await expect(dialog).toBeVisible();
	await dialog.getByLabel('Select model').click();
	await page.getByRole('button', { name: 'Multiple' }).click();
	// Not anchored at the end: a row's accessible name carries its capability
	// pill ("Mock Painter 2I").
	await page.getByRole('option', { name: /^Mock Painter/ }).click();
	// Toggle the picker shut rather than pressing Escape — the dialog is listening
	// for it too, and would close along with the popover.
	await dialog.getByLabel('Select model').click();

	// The button says what it is about to do — two branches, not one draw.
	const draw = dialog.getByRole('button', { name: 'Draw with 2 models' });
	await expect(draw).toBeEnabled();
	await draw.click();
}

test.beforeEach(() => resetData());

test.describe('flow: comparing avatar models', () => {
	test('draws a portrait per model, then adopts the one picked', async ({ page }) => {
		const convId = await sendChatFromHome(page, 'Describe how you look');

		// No avatar yet: the trigger is the placeholder glyph, not an image.
		await expect(page.locator('header img[src*="/api/media/"]')).toHaveCount(0);

		await drawWithTwoModels(page);

		// The dialog hands off to the grid rather than sitting on top of it.
		await expect(page.getByRole('dialog', { name: 'Draw the avatar' })).toBeHidden();
		await expect(page.getByText('Comparing 2 variations')).toBeVisible();
		const pick = page.getByRole('button', { name: 'Use this face' });
		await expect(pick).toHaveCount(2, { timeout: 15_000 });

		// Re-roll is offered while this page still holds the reviewed prompt. (It
		// is withheld on a grid recovered from server truth, where that prompt is
		// gone — the unit tests cover that half; this is the one an e2e can see.)
		await expect(page.getByRole('button', { name: 'Regenerate' })).toHaveCount(2);

		// Parked while it waits for the user: the marker is set, and the leaf sits
		// on the description the portraits hang under — which is what makes the
		// grid recoverable (see the next spec).
		const parked = conversationRow(convId);
		expect(parked.fanout_parent_message_id).not.toBeNull();
		expect(parked.active_leaf_message_id).toBe(parked.fanout_parent_message_id);
		expect(parked.avatar_media_id).toBeNull(); // nothing applied on arrival

		// Adopt the second candidate.
		await pick.nth(1).click();

		// The grid goes; the header is wearing a face.
		await expect(page.getByText('Comparing 2 variations')).toBeHidden();
		await expect(page.locator('header img[src*="/api/media/"]').first()).toBeVisible();

		const picked = conversationRow(convId);
		expect(picked.avatar_media_id).not.toBeNull();
		// The comparison is resolved (marker cleared) and the thread has moved onto
		// the chosen branch, so the next message continues from the face picked.
		expect(picked.fanout_parent_message_id).toBeNull();
		expect(picked.active_leaf_message_id).not.toBe(parked.active_leaf_message_id);

		// The loser is kept, not pruned: both portraits are still siblings under the
		// description, which is what the ‹N/M› arrows navigate.
		const db = new DatabaseSync(DB_PATH);
		try {
			const siblings = db
				.prepare(
					`SELECT COUNT(*) AS n FROM messages
					 WHERE conversation_id = ? AND parent_message_id = ? AND role = 'assistant'`,
				)
				.get(convId, parked.fanout_parent_message_id) as { n: number };
			expect(siblings.n).toBe(2);
		} finally {
			db.close();
		}

		// And the composer is usable again — a parked comparison holds it, so this
		// is the observable end of the whole interaction.
		await expect(page.getByRole('button', { name: 'Send message' })).toBeVisible();
	});

	test('rebuilds an unresolved comparison as a comparison, not a chat fan-out', async ({
		page,
	}) => {
		const convId = await sendChatFromHome(page, 'Describe how you look');
		await drawWithTwoModels(page);
		await expect(page.getByRole('button', { name: 'Use this face' })).toHaveCount(2, {
			timeout: 15_000,
		});

		// Walk away and come back with nothing picked. The whole grid is client
		// state; all the server has is the marker and the sibling portraits.
		await page.reload();

		await expect(page.getByText('Comparing 2 variations')).toBeVisible();
		const pick = page.getByRole('button', { name: 'Use this face' });
		await expect(pick).toHaveCount(2);
		// The label is the tell: a recovered avatar grid is indistinguishable from
		// an image fan-out by its contents, so this is the `avatar` wire flag having
		// survived the round trip. Get it wrong and the button reads "Continue with
		// this" and picks by continuing the chat with an image model.
		await expect(page.getByRole('button', { name: 'Continue with this' })).toHaveCount(0);

		// A pick after recovery still adopts the face — the half that would break if
		// the flag were lost, since the endpoint it posts to is chosen by mode.
		await pick.first().click();
		await expect(page.locator('header img[src*="/api/media/"]').first()).toBeVisible();
		expect(conversationRow(convId).avatar_media_id).not.toBeNull();
	});
});
