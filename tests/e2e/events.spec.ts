import { test, expect } from '@playwright/test';
import {
	MOCK_REPLY,
	generateImageFromHome,
	resetData,
	seedConversation,
	selectModel,
} from './helpers';

/**
 * Browser-event tranche — the recovery / state-machine cases the roadmap
 * called out as still uncovered after the happy-path flows landed. These
 * specs don't test "send a message"-style flows; they emulate the events
 * the runtime fires around suspension (`visibilitychange`), connectivity
 * changes (`online` / `offline`), programmatic composer text-sets (the
 * gallery → regenerate handoff), and branch switches (the auto-attach
 * state machine).
 *
 * The visibility/connectivity tests use the `Mock Chat Slow` model
 * (mock-upstream.mjs) so the stream is in flight long enough to dispatch
 * events while `busy === true` on the chat-id page — that's the gate
 * that flips the recovery flag. The default Mock Chat finishes in ~30ms
 * total, well before any post-send event handler could fire.
 *
 * Clean slate before each test for the same reason flows.spec.ts does:
 * one webServer / DB across both projects, so a leftover conversation
 * from a sibling test would break the deterministic title lookups here.
 */

test.beforeEach(() => resetData());

test.describe('event: visibilitychange recovery during in-flight stream', () => {
	test('hidden→visible while busy doesn’t surface an error toast', async ({ page }) => {
		const prompt = 'Visibility recovery hello';
		await page.goto('/');
		await expect(page.getByRole('button', { name: 'Select model' })).toContainText('Mock Chat');
		await selectModel(page, /^Mock Chat Slow$/);
		await page.locator('textarea').first().fill(prompt);
		const send = page.getByRole('button', { name: 'Send message' });
		await expect(send).toBeEnabled();
		await send.click();

		// Landed on the chat-id page; the InFlightBubble's "Thinking"
		// placeholder appears the moment the chat-id page kicks off its
		// send, which means its visibility/connectivity listeners are
		// attached and `busy === true`.
		await page.waitForURL(/\/chat\/[^/]+$/);
		await expect(page.getByText('Thinking', { exact: false }).first()).toBeVisible({
			timeout: 5_000,
		});

		// Mid-stream: hide, then come back. Hidden flips
		// wasHiddenDuringFetch=true while busy; visible triggers
		// invalidateAll. Playwright doesn't actually kill the fetch on
		// visibilitychange (real iOS suspension does), so the stream
		// keeps flowing — which is exactly the case the recovery path
		// is *also* designed to be safe for. The assertion below is the
		// regression we care about: a future change that crashed the
		// listener or routed it through the error-toast branch instead
		// of the silent-invalidate branch would fail this test.
		await page.evaluate(() => {
			Object.defineProperty(document, 'visibilityState', {
				configurable: true,
				get: () => 'hidden',
			});
			document.dispatchEvent(new Event('visibilitychange'));
		});
		await page.waitForTimeout(150);
		await page.evaluate(() => {
			Object.defineProperty(document, 'visibilityState', {
				configurable: true,
				get: () => 'visible',
			});
			document.dispatchEvent(new Event('visibilitychange'));
		});

		// Stream finishes; the canonical assistant row lands.
		await expect(page.getByText(MOCK_REPLY)).toBeVisible({ timeout: 10_000 });
		await expect(page.getByRole('button', { name: 'Send message' })).toBeVisible();

		// No "Load failed"-style error toast. The Toaster's only output
		// has role=status (UpdateBanner also uses it but doesn't appear
		// in test runs without a pending SW), so the role lookup is
		// effectively toast-specific here.
		await expect(page.getByRole('status')).toHaveCount(0);
	});
});

test.describe('event: online/offline recovery during in-flight stream', () => {
	test('offline→online mid-stream recovers without surfacing an error', async ({
		page,
		context,
	}) => {
		const prompt = 'Connectivity recovery hello';
		await page.goto('/');
		await expect(page.getByRole('button', { name: 'Select model' })).toContainText('Mock Chat');
		await selectModel(page, /^Mock Chat Slow$/);
		await page.locator('textarea').first().fill(prompt);
		const send = page.getByRole('button', { name: 'Send message' });
		await expect(send).toBeEnabled();
		await send.click();

		await page.waitForURL(/\/chat\/[^/]+$/);
		await expect(page.getByText('Thinking', { exact: false }).first()).toBeVisible({
			timeout: 5_000,
		});

		// Real offline: context.setOffline kills the in-flight SSE
		// stream AND fires the window 'offline' event. The chat-id
		// page's listener sets wasOfflineDuringFetch=true (busy is
		// still true), then the fetch's catch block swallows the
		// abort + calls invalidateAll instead of toasting "Load
		// failed". The server-side relay continues writing chunks to
		// the recorder regardless — by the time we go back online,
		// the assistant message is fully persisted in the DB and the
		// invalidate picks it up.
		await context.setOffline(true);
		// Give the catch path a beat to run — wasOfflineDuringFetch was
		// already set by the 'offline' event by this point, so the
		// catch sees the flag and silently invalidates.
		await page.waitForTimeout(500);
		await context.setOffline(false);

		// The full MOCK_REPLY lands once the server-side stream
		// finishes (kept alive by the relay's swallow-on-disconnect
		// recorder) and invalidateAll resolves. 15s timeout absorbs
		// the slow-chat total (~2s) plus the load function's refetch.
		await expect(page.getByText(MOCK_REPLY)).toBeVisible({ timeout: 15_000 });
		await expect(page.getByRole('status')).toHaveCount(0);
	});
});

test.describe('event: composer auto-resize after programmatic text-set', () => {
	test('gallery → regenerate populates the composer AND auto-grows it', async ({ page }) => {
		// The handoff is a sessionStorage payload that the new-chat
		// page's mount effect reads, applies to `text`, and clears.
		// We seed it directly rather than going through the gallery
		// lightbox: the flows.spec.ts gallery test already exercises
		// that path, and here we want to isolate the auto-resize
		// behavior on the programmatic text-set — the case ComposerCore's
		// $effect on bound `text` is wired for.
		const longPrompt = [
			'A truly enormous and considered prompt that should drive the',
			'composer textarea well past its single-row height, because the',
			'$effect in ComposerCore.svelte is supposed to react to the bound',
			'`text` change and call autoResizeTextarea(el) once the DOM has',
			'flushed — without that, a programmatic set leaves the textarea',
			'stuck at one row even though the content overflows.',
		].join('\n');

		// Baseline: an empty composer's natural single-row height.
		await page.goto('/');
		const textarea = page.locator('textarea').first();
		await expect(textarea).toBeVisible();
		const baselineHeight = await textarea.evaluate((el) => el.clientHeight);

		// Stash the gallery-launch intent, then navigate to / again so
		// the mount effect runs and consumes the sessionStorage key.
		await page.evaluate((prompt) => {
			window.sessionStorage.setItem(
				'glyphstream:galleryLaunch',
				JSON.stringify({ kind: 'regenerate', prompt, sourceModelId: null }),
			);
		}, longPrompt);
		await page.goto('/');

		// Composer populated by the gallery-launch effect.
		await expect(textarea).toHaveValue(longPrompt);

		// And the auto-resize $effect ran post-flush — the textarea is
		// noticeably taller than its single-row baseline. We pick a
		// conservative threshold (2× baseline) so font/line-height
		// drift between browsers can't flake it, while being well below
		// what a six-line prompt actually produces.
		await expect
			.poll(async () => textarea.evaluate((el) => el.clientHeight), { timeout: 2_000 })
			.toBeGreaterThan(baselineHeight * 2);
	});
});

test.describe('event: autoattach state machine on branch switches', () => {
	test('editing the prompt re-points the auto-attached image at the new branch', async ({
		page,
	}) => {
		// Image model: a successful generation lands an assistant image,
		// and the auto-attach effect pre-fills the next-turn composer
		// with that image so I2I edits ("make the sky blue") Just Work.
		// Editing the user message creates a sibling branch with its own
		// image — the effect's job is to drop the stale attachment and
		// re-attach the new branch's image. Switching siblings should
		// swap it back. That's the state machine we're poking at here.
		const original = 'Branch autoattach original prompt';
		const edited = 'Branch autoattach edited prompt';
		await generateImageFromHome(page, original);

		// The attached thumbnail lives inside the composer <form>; the
		// assistant-message image sits in the message list above it. We
		// scope to the form to keep the two unambiguous.
		const composerThumb = page.locator('form img[src*="/api/media/"]').first();
		const attachedMediaId = async () => {
			const src = await composerThumb.getAttribute('src');
			const m = src?.match(/\/api\/media\/([^/]+)\/content/);
			return m ? m[1] : null;
		};

		// Wait until the auto-attach effect lands the first image.
		await expect(composerThumb).toBeVisible({ timeout: 5_000 });
		const branchAMediaId = await attachedMediaId();
		expect(branchAMediaId).toBeTruthy();

		// Edit the root user message → spawns a sibling branch that
		// re-runs image generation and lands a new image. The composer
		// finishes by auto-attaching THAT image, not the original.
		await page.getByRole('button', { name: 'Edit message' }).click();
		const editor = page.locator('article', { hasText: 'Editing' });
		await editor.locator('textarea').fill(edited);
		await page.getByRole('button', { name: 'Save' }).click();

		// Wait for the new branch to finish: the sibling-nav controls
		// appear once a sibling exists.
		await expect(page.getByRole('button', { name: 'Previous sibling' })).toBeVisible();

		// The auto-attached mediaId should have swapped to the new
		// branch's image. Poll because the post-stream attach is a
		// post-mount effect.
		await expect.poll(attachedMediaId, { timeout: 10_000 }).not.toBe(branchAMediaId);
		const branchBMediaId = await attachedMediaId();
		expect(branchBMediaId).toBeTruthy();

		// Navigating back to the original branch via the sibling arrows
		// should swap the auto-attached image back to branchAMediaId —
		// the auto-attach effect's "leaf assistant changed → drop the
		// stale auto-attached item, re-attach the new leaf's image"
		// transition.
		const prev = page.getByRole('button', { name: 'Previous sibling' });
		await expect(prev).toBeEnabled();
		await prev.click();
		await expect.poll(attachedMediaId, { timeout: 10_000 }).toBe(branchAMediaId);
	});
});

test.describe('event: conversation list refreshes when the app returns to the foreground', () => {
	test('a conversation created on another client appears after hidden→visible', async ({
		page,
	}) => {
		const title = 'Seeded on another client';
		await page.goto('/');

		// Baseline: the (app) layout loaded its sidebar before the row existed,
		// so Recents doesn't have it.
		const row = page.getByRole('link', { name: title });
		await expect(row).toHaveCount(0);

		// Emulate a sibling client creating a conversation: the server now has
		// the row, but this page's SSR sidebar data doesn't — and nothing on
		// this client has re-run the layout load, so it stays invisible.
		seedConversation(title);
		await expect(row).toHaveCount(0);

		// Resume from background. hidden→visible fires the (app) layout's
		// visibilitychange handler, which invalidate('app:conversations')s and
		// re-runs listConversations — the fix under test. (A bare focus /
		// pageshow-persisted event drives the same refresh path.)
		await page.evaluate(() => {
			Object.defineProperty(document, 'visibilityState', {
				configurable: true,
				get: () => 'hidden',
			});
			document.dispatchEvent(new Event('visibilitychange'));
			Object.defineProperty(document, 'visibilityState', {
				configurable: true,
				get: () => 'visible',
			});
			document.dispatchEvent(new Event('visibilitychange'));
		});

		await expect(row).toBeVisible({ timeout: 5_000 });
	});
});
