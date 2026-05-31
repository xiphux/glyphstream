import { test, expect } from '@playwright/test';
import {
	MOCK_REPLY,
	openSidebar,
	resetData,
	sendChatFromHome,
	generateImageFromHome,
} from './helpers';

// Clean slate before each flow — see resetData's header for why the
// shared-DB-across-projects model needs this.
test.beforeEach(() => resetData());

/**
 * High-value end-to-end flows, run against the mock OpenAI upstream (see
 * tests/e2e/fixtures/mock-upstream.mjs). These cover the browser-event
 * territory the roadmap flagged as manual-test-only: the create→navigate→
 * stream handoff, branch creation on edit, archive/undo, and the gallery
 * sessionStorage launch handoff.
 *
 * State note: workers=1 and the DB is wiped once in global-setup, so these
 * specs run after authenticated.spec (alphabetical) which asserts empty-
 * state surfaces — these create conversations + media, so they must not
 * precede those. Each test uses a unique title so it can target its own
 * conversation regardless of leftover state from sibling tests.
 */

test.describe('flow: send a chat message', () => {
	test('creates a conversation and streams the assistant reply', async ({ page }) => {
		const prompt = 'Send flow hello';
		await sendChatFromHome(page, prompt);
		// Both bubbles rendered. Scope the prompt to the message body —
		// the same title text also lands in the sidebar link + chat header.
		await expect(page.locator('div.whitespace-pre-wrap', { hasText: prompt })).toBeVisible();
		await expect(page.getByText(MOCK_REPLY)).toBeVisible();
	});
});

test.describe('flow: edit a root message branches', () => {
	test('editing the root user message creates a navigable sibling branch', async ({ page }) => {
		const original = 'Branch flow original root';
		const edited = 'Branch flow edited root';
		await sendChatFromHome(page, original);

		// Message bodies use .whitespace-pre-wrap; the sidebar link + chat
		// header reuse the same title text, so scope to the bubble.
		const body = (text: string) => page.locator('div.whitespace-pre-wrap', { hasText: text });

		// The single user message's edit button is opacity-0 until hover on
		// desktop, but opacity-0 elements are still clickable.
		await page.getByRole('button', { name: 'Edit message' }).click();
		const editor = page.locator('article', { hasText: 'Editing' });
		await editor.locator('textarea').fill(edited);
		await page.getByRole('button', { name: 'Save' }).click();

		// A sibling now exists → branch nav appears, and the edited text is
		// the active branch.
		await expect(page.getByRole('button', { name: 'Next sibling' })).toBeVisible();
		const prev = page.getByRole('button', { name: 'Previous sibling' });
		await expect(prev).toBeVisible();
		await expect(body(edited)).toBeVisible();

		// Navigating back to the previous sibling restores the original
		// (wait out the post-edit generation that disables the nav).
		await expect(prev).toBeEnabled();
		await prev.click();
		await expect(body(original)).toBeVisible();
	});
});

test.describe('flow: archive with undo', () => {
	test('archiving removes the conversation; Undo restores it', async ({ page, isMobile }) => {
		const title = 'Archive flow conversation';
		await sendChatFromHome(page, title);

		// The conversation appears in the sidebar with its (preview) title.
		await openSidebar(page, isMobile);
		const overflow = page.getByRole('button', { name: `Options for conversation ${title}` });
		await expect(overflow).toBeVisible();
		await overflow.click();
		await page.getByRole('menuitem', { name: 'Archive' }).click();

		// Toast confirms + offers Undo; the row leaves the sidebar.
		const toast = page.getByRole('status');
		await expect(toast).toContainText('Conversation archived');
		await expect(
			page.getByRole('button', { name: `Options for conversation ${title}` }),
		).toHaveCount(0);

		// Undo restores it (and navigates back to the chat we were viewing).
		await toast.getByRole('button', { name: 'Undo' }).click();
		await openSidebar(page, isMobile);
		await expect(
			page.getByRole('button', { name: `Options for conversation ${title}` }),
		).toBeVisible();
	});
});

test.describe('flow: generate image + regenerate from gallery', () => {
	test('a generated image lands in the gallery and regenerate prefills home', async ({ page }) => {
		const prompt = 'a crimson square on white';
		await generateImageFromHome(page, prompt);

		// The asset shows up in the gallery grid.
		await page.goto('/gallery');
		const thumb = page.getByRole('button', { name: /^Open image/ }).first();
		await expect(thumb).toBeVisible();
		await thumb.click();

		// Lightbox opens; "Regenerate with this prompt" hands the prompt off
		// to the home composer via sessionStorage and navigates there.
		await expect(page.getByRole('dialog', { name: 'Media preview' })).toBeVisible();
		await page.getByRole('button', { name: 'Regenerate with this prompt' }).click();

		await page.waitForURL((url) => url.pathname === '/');
		await expect(page.locator('textarea').first()).toHaveValue(prompt);
	});
});

test.describe('flow: theme switcher', () => {
	test('selecting a theme applies it live and survives a reload (no FOUC)', async ({ page }) => {
		await page.goto('/settings/preferences');
		const html = page.locator('html');
		// Default theme carries no data-theme attribute.
		await expect(html).not.toHaveAttribute('data-theme', /.+/);

		// Pick Claude — the switcher flips the attribute live (no reload).
		await page.getByRole('button', { name: /^Claude/ }).click();
		await expect(html).toHaveAttribute('data-theme', 'claude');

		// theme-color meta tracks the active surface (PWA status-bar tint).
		await expect
			.poll(async () => {
				const meta = await page.locator('meta[name="theme-color"]').getAttribute('content');
				const bodyBg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
				return meta === bodyBg && !!bodyBg;
			})
			.toBe(true);

		// Reload: the gs-theme cookie → hooks transformPageChunk means the
		// attribute is in the server-rendered HTML before any JS runs, so it
		// persists with no flash of the default.
		await page.reload();
		await expect(html).toHaveAttribute('data-theme', 'claude');

		// Switching back to the default clears the attribute again (and
		// leaves the DB pref clean for other tests).
		await page.getByRole('button', { name: /^GlyphStream/ }).click();
		await expect(html).not.toHaveAttribute('data-theme', /.+/);
	});
});
