import { test, expect } from '@playwright/test';
import { openSidebar, resetData, sendChatFromHome, sendFollowup } from './helpers';

// Clean slate before each flow (shared DB across projects — see resetData).
test.beforeEach(() => resetData());

/**
 * Composer draft autosave (see src/lib/composer-draft.ts). The module's pure
 * logic — debounce, TTL, cross-conversation flush — is unit-tested; these e2e
 * cases lock in the wiring that unit tests can't reach: the live two-way bind
 * persisting on keystroke, restore on reload, restore on conversation switch,
 * and clearing on submit. The integration spans two route files plus the
 * shared composer, so a refactor could break it while unit tests stay green.
 *
 * State note: workers=1, DB wiped once in global-setup; these create
 * conversations, so they run after authenticated.spec's empty-state assertions
 * (alphabetical order). Each test resets first and uses unique titles.
 */

const draftKey = (id: string | null) => `glyphstream:composerDraft:${id ?? 'new'}`;
const readDraft = (page: import('@playwright/test').Page, id: string | null) =>
	page.evaluate((k) => localStorage.getItem(k), draftKey(id));

test.describe('composer draft: new-chat box', () => {
	test('a half-typed prompt is restored after a reload', async ({ page }) => {
		await page.goto('/');
		// Gate on hydration + default-model selection (composer interactive).
		await expect(page.getByRole('button', { name: 'Select model' })).toContainText('Mock Chat');

		const draft = 'Half-typed new-chat prompt that should survive a reload';
		await page.locator('textarea').first().fill(draft);

		// Wait for the debounced autosave to land, then reload.
		await expect.poll(() => readDraft(page, null)).toContain(draft);
		await page.reload();

		await expect(page.getByRole('button', { name: 'Select model' })).toContainText('Mock Chat');
		await expect(page.locator('textarea').first()).toHaveValue(draft);
	});

	test('submitting clears the draft so it is not restored later', async ({ page }) => {
		// sendChatFromHome fills the composer, submits, and waits for the reply.
		await sendChatFromHome(page, 'New-chat draft clear-on-submit prompt');

		// The new-chat slot is gone immediately after the handoff.
		await expect.poll(() => readDraft(page, null)).toBeNull();

		// Returning to the new-chat page shows an empty composer.
		await page.goto('/');
		await expect(page.getByRole('button', { name: 'Select model' })).toContainText('Mock Chat');
		await expect(page.locator('textarea').first()).toHaveValue('');
	});
});

test.describe('composer draft: existing conversation', () => {
	test('an unsent follow-up is restored after a reload', async ({ page }) => {
		const convId = await sendChatFromHome(page, 'Follow-up reload conversation');

		const draft = 'Unsent follow-up that should survive a reload';
		await page.locator('textarea').first().fill(draft);
		await expect.poll(() => readDraft(page, convId)).toContain(draft);

		await page.reload();
		await expect(page.locator('textarea').first()).toHaveValue(draft);
	});

	test('sending a follow-up clears its draft', async ({ page }) => {
		const convId = await sendChatFromHome(page, 'Follow-up clear conversation');

		const draft = 'Follow-up that gets sent';
		await page.locator('textarea').first().fill(draft);
		await expect.poll(() => readDraft(page, convId)).toContain(draft);

		await sendFollowup(page, draft);

		await expect.poll(() => readDraft(page, convId)).toBeNull();
		await page.reload();
		await expect(page.locator('textarea').first()).toHaveValue('');
	});
});

test.describe('composer draft: per-conversation isolation', () => {
	test('drafts stay isolated and restore across client-side switches', async ({
		page,
		isMobile,
	}) => {
		const convA = await sendChatFromHome(page, 'Isolation conversation A');
		const convB = await sendChatFromHome(page, 'Isolation conversation B'); // now viewing B

		const composer = page.locator('textarea').first();

		// Type into B but don't send. Switch to A *immediately* (no wait): a
		// client-side nav fires no page-hide, so this exercises the writer's
		// cross-conversation flush — B's pending draft must not be stranded.
		const draftB = 'Unsent draft for conversation B';
		await composer.fill(draftB);

		await openSidebar(page, isMobile);
		await page.locator(`a[href="/chat/${convA}"]`).click();
		await page.waitForURL(`**/chat/${convA}`);

		// A has no draft of its own → no bleed from B.
		await expect(composer).toHaveValue('');

		// Type into A, then switch back to B.
		const draftA = 'Unsent draft for conversation A';
		await composer.fill(draftA);

		await openSidebar(page, isMobile);
		await page.locator(`a[href="/chat/${convB}"]`).click();
		await page.waitForURL(`**/chat/${convB}`);
		await expect(composer).toHaveValue(draftB);

		// And A still holds its own draft.
		await openSidebar(page, isMobile);
		await page.locator(`a[href="/chat/${convA}"]`).click();
		await page.waitForURL(`**/chat/${convA}`);
		await expect(composer).toHaveValue(draftA);
	});
});
