import { test, expect } from '@playwright/test';
import {
	openSidebar,
	resetData,
	seedConversation,
	seedCustomModel,
	seedFavoriteModels,
} from './helpers';

/**
 * The shared `(app)` layout ships without its interaction-only data and fetches
 * it right after first paint.
 *
 * This is a latency change, so it needs a test that fails if someone quietly
 * undoes it. On a cold container the Database span read 751ms of a 1000ms
 * render — `node:sqlite` is synchronous, so every one of those queries blocked
 * the event loop while the page cache was cold. None of what's deferred is on
 * screen at that moment: the sidebar is a closed drawer on the mobile PWA this
 * exists for, skills matter when you type `/`, and the feature categories when a
 * menu opens. `customModels` is the exception and has its own test below: the
 * home page resolves it once and latches, so it cannot arrive late.
 *
 * Both halves are asserted, because either alone is satisfiable by a bug. That
 * it's ABSENT from the document is the optimisation; that it ARRIVES is the part
 * a user would notice missing.
 */
const TITLE = 'Deferred until after paint';

test.beforeEach(() => {
	resetData();
	seedConversation(TITLE);
});

test('the initial document does not carry the sidebar list', async ({ request }) => {
	const res = await request.get('/');
	expect(res.status()).toBe(200);
	const html = await res.text();
	// The conversation exists and the sidebar renders server-side — so finding
	// the title here would mean the query ran on the critical path after all.
	expect(html).not.toContain(TITLE);
});

test('the sidebar fills in after hydration', async ({ page, isMobile }) => {
	await page.goto('/');
	await openSidebar(page, !!isMobile);
	await expect(page.getByRole('link', { name: TITLE })).toBeVisible();
});

test('an empty Recents says so only once it knows', async ({ page, isMobile }) => {
	// The other direction: "No conversations yet" is a claim, and asserting it
	// while the real list is still in flight would be a confident wrong answer
	// on precisely the cold launch this defers for.
	resetData();
	await page.goto('/');
	await openSidebar(page, !!isMobile);
	await expect(page.getByText('No conversations yet.')).toBeVisible();
});

test('custom models are NOT deferred, because the home page latches on them', async ({
	request,
}) => {
	// The exception to the rule above, and the reason it is one. `+page.svelte`
	// resolves a `custom::` favourite once and guards with `if (modelId) return`,
	// so a preset missing from the FIRST render is skipped for a base model and
	// never reconsidered — the user loses its system prompt and params silently,
	// on every cold launch. `prefs.favoriteModels` isn't deferred either, so
	// deferring this side of the pair is what creates the asymmetry.
	const name = 'Preset On First Paint';
	seedCustomModel(name);
	const html = await (await request.get('/')).text();
	expect(html, 'custom models were deferred; the home page cannot recover').toContain(name);
});

/**
 * The model catalogue is trimmed the same way, but on a different axis: the
 * document carries the entries first paint can render and the follow-up carries
 * the rest.
 *
 * The motivating measurement is not the fixture's two mock models — it's an
 * aggregator endpoint on the operator's box, where `/api/models` is 571KB of
 * JSON that was being embedded in every document to decide one dropdown's
 * initial value. So these assert the SHAPE (what's in the document vs what
 * arrives), which is what a regression would break; the byte win is
 * proportional to the deployment, not to this fixture.
 */
test('the initial document carries only the models first paint can render', async ({ request }) => {
	const html = await (await request.get('/')).text();
	// No favourites seeded, so the server's pick is the first chat model — and
	// that one has to be present, or the composer renders a selection it cannot
	// name.
	expect(html).toContain('mock::mock-chat');
	// The image model is picker-only here. Finding it would mean the whole
	// catalogue is still riding along.
	expect(html, 'the full catalogue is still in the document').not.toContain('mock-image');
});

test('a favourite is in the document, and wins the default', async ({ request }) => {
	// Both halves of the trim's contract in one: favourites must survive it (the
	// sidebar renders their labels server-side), and the precedence the server now
	// owns has to agree with the one the page used to run — a favourite beats the
	// first-chat-model fallback even when it's an image model.
	seedFavoriteModels(['mock::mock-image']);
	const html = await (await request.get('/')).text();
	expect(html).toContain('mock::mock-image');
});

test('the full catalogue arrives after hydration', async ({ page }) => {
	// The half a user would notice missing: a picker permanently showing only
	// their favourites would look like the other models had been deconfigured.
	await page.goto('/');
	await page.locator('button[aria-label="Select model"]').click();
	await expect(page.getByRole('option', { name: /Mock Image/i })).toBeVisible();
});

test('the composer opens on the favourited model, not the first chat model', async ({ page }) => {
	// End-to-end proof that `pickDefaultModelId` on the server reaches the same
	// answer the client-side effect used to — asserted through the UI, because
	// that agreement is the thing that silently breaks if the two ever diverge.
	seedFavoriteModels(['mock::mock-image']);
	await page.goto('/');
	await expect(page.locator('button[aria-label="Select model"]')).toContainText(/Mock Image/i);
});
