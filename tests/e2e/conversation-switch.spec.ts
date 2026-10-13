import { test, expect, type Page } from './fixtures/test';
import {
	generateImageFromHome,
	readConversationDisabledFeatures,
	resetData,
	seedConversation,
	seedConversationMessages,
	setConversationDisabledFeatures,
} from './helpers';

/**
 * Per-conversation state must follow the conversation when you switch between
 * two of them from the sidebar.
 *
 * The chat page component is reused across /chat/A → /chat/B (no remount), so
 * anything seeded once from page data and not re-seeded on the switch shows
 * the previous conversation's value — and anything written back from it then
 * overwrites the new conversation with the old one's.
 */

test.beforeEach(() => resetData());
test.skip(({ isMobile }) => isMobile, 'the sidebar is a drawer on mobile; the switch is the same');

async function webAccessChecked(page: Page): Promise<string | null> {
	await page.getByRole('button', { name: 'Feature toggles' }).click();
	const value = await page.getByRole('switch', { name: 'Web access' }).getAttribute('aria-checked');
	await page.keyboard.press('Escape');
	return value;
}

test('feature toggles follow the conversation, and toggling one does not copy the other', async ({
	page,
}) => {
	const webOff = seedConversation('Web is off here');
	seedConversationMessages(webOff, 1, 'off');
	setConversationDisabledFeatures(webOff, ['web']);
	const webOn = seedConversation('Web is on here');
	seedConversationMessages(webOn, 1, 'on');

	await page.goto(`/chat/${webOff}`);
	expect(await webAccessChecked(page)).toBe('false');

	await page.getByRole('link', { name: 'Web is on here' }).click();
	await page.waitForURL(`**/chat/${webOn}`);
	expect(await webAccessChecked(page)).toBe('true');

	// Change a different toggle in the second conversation: what gets saved is
	// this conversation's list plus the change, never the first one's list.
	await page.getByRole('button', { name: 'Feature toggles' }).click();
	await page.getByRole('switch', { name: 'Personalization' }).click();
	await page.keyboard.press('Escape');
	await expect.poll(() => readConversationDisabledFeatures(webOn)).toEqual(['personalization']);
});

test('an open image preview closes when search takes you to another conversation', async ({
	page,
}) => {
	const other = seedConversation('Somewhere else entirely');
	seedConversationMessages(other, 1, 'else');
	await generateImageFromHome(page, 'a lighthouse at dusk');

	await page.locator('main img[src*="/api/media/"]').first().click();
	const preview = page.getByRole('dialog', { name: 'Media preview' });
	await expect(preview).toBeVisible();

	// The search modal opens over the preview; picking a result navigates
	// without unmounting the chat page.
	await page.keyboard.press('ControlOrMeta+k');
	const search = page.getByRole('dialog', { name: 'Search chats' });
	await search.getByRole('textbox', { name: 'Search query' }).fill('Somewhere else');
	await search
		.getByRole('button', { name: /Somewhere else entirely/ })
		.first()
		.click();
	await page.waitForURL(`**/chat/${other}`);

	await expect(preview).toHaveCount(0);
});

test('a search hit in another conversation scrolls to and highlights that message', async ({
	page,
}) => {
	const first = seedConversation('Where we start');
	seedConversationMessages(first, 1, 'start');
	const target = seedConversation('Where the needle is');
	seedConversationMessages(target, 30, 'needle');

	await page.goto(`/chat/${first}`);
	// The shortcut is bound once the app has hydrated.
	await expect(page.getByRole('button', { name: 'Select model' })).toBeEnabled();
	await page.keyboard.press('ControlOrMeta+k');
	const search = page.getByRole('dialog', { name: 'Search chats' });
	// seedConversationMessages writes "Question <i>" user turns; pick an early one
	// so it sits well above the bottom the page would otherwise open at.
	await search.getByRole('textbox', { name: 'Search query' }).fill('Question 3');
	await search
		.getByRole('button', { name: /Where the needle is/ })
		.first()
		.click();
	await page.waitForURL(`**/chat/${target}#msg-*`);

	const hit = page.locator(`#${new URL(page.url()).hash.slice(1)}`);
	await expect(hit).toHaveClass(/bg-amber-200/);
	await expect(hit).toBeInViewport();
});
