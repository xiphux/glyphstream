import { test, expect, type Page } from '@playwright/test';
import { MOCK_REPLY, resetData, sendChatFromHome, selectModel } from './helpers';

/**
 * Cross-device presence heartbeat — the CLIENT wiring behind notification
 * suppression, which the unit tests can't reach (it's Svelte effects + DOM
 * visibility + fetch timing). These assert the network CONTRACT the server's
 * suppression depends on: while a tab is actively rendering a generation it
 * POSTs /api/presence {visible:true}, and it clears with {visible:false} when
 * the turn settles or the tab is backgrounded.
 *
 * No push/VAPID/service-worker machinery is involved: the suppression DECISION
 * is unit-tested in push-notify.test.ts; this covers the signal that feeds it —
 * exactly the part where the client-side regressions (publishing the wrong
 * conversation, never clearing) lived.
 */

test.beforeEach(() => resetData());

interface Beat {
	conversationId: string;
	viewerId: string;
	visible: boolean;
}

/** Collect every POST /api/presence body the page sends, in order. */
function capturePresenceBeats(page: Page): Beat[] {
	const beats: Beat[] = [];
	page.on('request', (req) => {
		if (req.method() !== 'POST' || !req.url().endsWith('/api/presence')) return;
		const body = req.postData();
		if (body) beats.push(JSON.parse(body) as Beat);
	});
	return beats;
}

test('publishes presence while rendering a turn and clears it when the turn settles', async ({
	page,
}) => {
	// Open a conversation first; start capturing only afterwards, so we assert
	// the follow-up's beats from a stably-mounted chat page rather than the
	// home -> chat first-message handoff.
	const convId = await sendChatFromHome(page, 'Presence lifecycle hello');
	const beats = capturePresenceBeats(page);

	// A follow-up turn: renderingGeneration flips true -> publishes visible:true.
	await page.locator('textarea').first().fill('Presence follow-up');
	const send = page.getByRole('button', { name: 'Send message' });
	await expect(send).toBeEnabled();
	await send.click();

	// While rendering: a visible:true beat lands for THIS conversation.
	await expect.poll(() => beats.some((b) => b.conversationId === convId && b.visible)).toBe(true);

	// Turn settles (composer flips Stop -> Send) -> a clearing visible:false beat.
	await expect(page.getByText(MOCK_REPLY)).toHaveCount(2);
	await expect(page.getByRole('button', { name: 'Send message' })).toBeVisible();
	await expect.poll(() => beats.some((b) => b.conversationId === convId && !b.visible)).toBe(true);

	// Every beat carries the same per-tab viewerId (minted once per page load),
	// and never for a different conversation.
	expect(beats.every((b) => b.conversationId === convId)).toBe(true);
	const viewerIds = new Set(beats.map((b) => b.viewerId));
	expect(viewerIds.size).toBe(1);
	expect([...viewerIds][0]).toBeTruthy();
});

test('stops reporting presence when the tab is backgrounded mid-generation', async ({ page }) => {
	// Slow model so the turn is still streaming when we background the tab.
	const convId = await sendChatFromHome(page, 'Presence visibility hello');
	await selectModel(page, /Mock Chat Slow/);
	const beats = capturePresenceBeats(page);

	await page.locator('textarea').first().fill('Slow follow-up');
	const send = page.getByRole('button', { name: 'Send message' });
	await expect(send).toBeEnabled();
	await send.click();

	// Generation is genuinely in-flight (Stop shown) and reporting visible:true.
	await expect(page.getByRole('button', { name: 'Stop generation' })).toBeVisible();
	await expect.poll(() => beats.some((b) => b.conversationId === convId && b.visible)).toBe(true);

	// Desktop tab-switch to hidden: a visible tab that's no longer being looked
	// at must stop suppressing the user's OTHER devices, so presence clears at
	// once (not on TTL). Same visibilitychange simulation as fanout.spec.ts.
	await page.evaluate(() => {
		Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
		document.dispatchEvent(new Event('visibilitychange'));
	});
	await expect.poll(() => beats.some((b) => b.conversationId === convId && !b.visible)).toBe(true);

	// Restore visibility and let the turn settle, so the next test's resetData()
	// doesn't race the in-flight recorder (the FK-constraint race helpers warn of).
	await page.evaluate(() => {
		Object.defineProperty(document, 'visibilityState', {
			configurable: true,
			get: () => 'visible',
		});
		document.dispatchEvent(new Event('visibilitychange'));
	});
	await expect(page.getByText(MOCK_REPLY)).toHaveCount(2, { timeout: 15_000 });
	await expect(page.getByRole('button', { name: 'Send message' })).toBeVisible();
});
