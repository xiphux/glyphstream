import { test, expect, type Page } from './fixtures/test';
import {
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
