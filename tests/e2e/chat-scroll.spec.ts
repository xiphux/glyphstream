import { test, expect, type Page } from './fixtures/test';
import { resetData, seedConversation, seedConversationMessages, openSidebar } from './helpers';

/**
 * Entering a conversation must land on its NEWEST message.
 *
 * Regression guard for a real bug: `content-visibility: auto` was added to the
 * message wrappers as a cheap off-screen render optimization, which collapsed
 * every unrendered row to a `contain-intrinsic-size` placeholder. That made the
 * scroll container's `scrollHeight` an estimate — measured 13732px against a
 * real 31936px on this very seed — and since pin-to-bottom is
 * `scrollTop = el.scrollHeight`, entering a conversation parked the view ~40%
 * of the way in rather than at the end. See the comment on the message wrapper
 * in the chat page.
 *
 * The assertions are therefore deliberately about *real* geometry: the newest
 * message is on screen, AND the container's reported height matches what the
 * rows actually occupy. A height-estimating optimization passes the first check
 * by accident (it's self-consistent within its own wrong layout) but fails the
 * second.
 */

const PAIRS = 30;

/**
 * The scroll container's reported height, vs. its height once every message row
 * is forced to render.
 *
 * Measuring the rows' own boxes would NOT catch the bug: a collapsed row's
 * `getBoundingClientRect()` returns the placeholder size too, so the estimate is
 * self-consistent and matches. Forcing `content-visibility: visible` is what
 * exposes the gap between "what the container claims" and "what's really there".
 */
async function geometry(page: Page) {
	return page.evaluate(() => {
		const rows = Array.from(document.querySelectorAll<HTMLElement>('[id^="msg-"]'));
		let el: HTMLElement | null = rows[0] ?? null;
		while (el && el.scrollHeight <= el.clientHeight + 1) el = el.parentElement;
		if (!el || rows.length === 0) return null;

		const reportedHeight = el.scrollHeight;
		const prior = rows.map((r) => r.style.contentVisibility);
		for (const r of rows) r.style.contentVisibility = 'visible';
		void el.offsetHeight; // force reflow
		const forcedHeight = el.scrollHeight;
		rows.forEach((r, i) => {
			r.style.contentVisibility = prior[i];
		});
		return { reportedHeight, forcedHeight };
	});
}

test.describe('chat: entering a conversation', () => {
	test('lands on the newest message (direct load)', async ({ page }) => {
		resetData();
		const id = seedConversation('Long Direct Thread');
		const newest = seedConversationMessages(id, PAIRS, 'direct');

		await page.goto(`/chat/${id}`);
		await expect(page.locator(`#msg-${newest}`)).toBeAttached();

		await expect(page.locator(`#msg-${newest}`)).toBeInViewport();

		// The container must report the height the rows really occupy — no
		// placeholder-collapsed estimate. Slack covers the composer bottom-padding.
		const g = await geometry(page);
		expect(g).not.toBeNull();
		expect(g!.reportedHeight).toBeGreaterThan(g!.forcedHeight * 0.9);
	});

	test('lands on the newest message (sidebar navigation)', async ({ page, isMobile }) => {
		resetData();
		const id = seedConversation('Long Sidebar Thread');
		const newest = seedConversationMessages(id, PAIRS, 'sidebar');

		// Client-side navigation in, rather than a fresh document load.
		await page.goto('/');
		await openSidebar(page, !!isMobile);
		await page
			.getByRole('link', { name: /Long Sidebar Thread/ })
			.first()
			.click();
		await expect(page.locator(`#msg-${newest}`)).toBeAttached();

		await expect(page.locator(`#msg-${newest}`)).toBeInViewport();

		const g = await geometry(page);
		expect(g).not.toBeNull();
		expect(g!.reportedHeight).toBeGreaterThan(g!.forcedHeight * 0.9);
	});
});

/**
 * A long conversation opens on its newest window and loads older messages as
 * the reader scrolls up — without moving what they're looking at.
 */
test.describe('chat: loading earlier messages', () => {
	/** 120 messages: three windows' worth. */
	const LONG = 60;

	const rowCount = (page: Page) => page.locator('[id^="msg-"]').count();

	/** Scroll the message list exactly to its top the way a reader does — with
	 *  the wheel, which also ends the entry hold that keeps a fresh conversation
	 *  at the bottom. Exactly: a bigger fling keeps scrolling through each
	 *  window as it lands, as a real one would, and loads several at once. */
	async function wheelToTop(page: Page) {
		// Hover a row that is already on screen: hovering an off-screen one makes
		// Playwright scroll it into view programmatically, which no reader can do
		// and which (no input event) leaves the entry hold pinning the bottom.
		const list = page.locator('[id^="msg-"]').last();
		await list.hover();
		const scrollTop = await list.evaluate((row) => {
			let el: Element | null = row;
			while (el && getComputedStyle(el).overflowY !== 'auto') el = el.parentElement;
			return el?.scrollTop ?? 0;
		});
		await page.mouse.wheel(0, -scrollTop);
	}

	test('opens on a window and loads the rest on the way up, keeping the view still', async ({
		page,
	}) => {
		resetData();
		const id = seedConversation('Very Long Thread');
		const newest = seedConversationMessages(id, LONG, 'long');
		await page.goto(`/chat/${id}`);
		await expect(page.locator(`#msg-${newest}`)).toBeInViewport();

		const initial = await rowCount(page);
		expect(initial).toBeGreaterThan(0);
		expect(initial).toBeLessThan(LONG * 2);
		await expect(page.locator('#msg-long-u-0')).toHaveCount(0);

		// The first loaded row, which the reader is looking at once at the top.
		const firstId = await page.locator('[id^="msg-"]').first().getAttribute('id');
		await wheelToTop(page);
		await expect.poll(() => rowCount(page)).toBeGreaterThan(initial);
		// It stays on screen rather than being pushed down by the rows above it.
		await expect(page.locator(`#${firstId}`)).toBeInViewport();

		// Keep going until the whole thread is in.
		await expect
			.poll(
				async () => {
					await wheelToTop(page);
					return rowCount(page);
				},
				{ timeout: 15_000 },
			)
			.toBe(LONG * 2);
		await expect(page.locator('#msg-long-u-0')).toBeAttached();
	});

	test('a link to a message older than the window loads back to it', async ({ page }) => {
		resetData();
		const id = seedConversation('Deep Link Thread');
		seedConversationMessages(id, LONG, 'deep');
		await page.goto(`/chat/${id}#msg-deep-u-3`);
		await expect(page.locator('#msg-deep-u-3')).toBeInViewport();
	});
});
