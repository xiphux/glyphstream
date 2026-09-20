/**
 * The composer's aspect-ratio selector, end to end.
 *
 * The thing worth proving here is the whole chain, because every link is
 * plausible-looking on its own and silently wrong together: the bridge's
 * `aspect_ratios` reaches `ModelEntry`, the control renders only for models
 * that advertise it, a pick sticks across models and reloads, and the value
 * actually lands on the upstream request body. The mock upstream records the
 * last `aspect_ratio` it was sent (`/__last-image-request`), which is the only
 * place that last claim is observable.
 */
import { test, expect } from './fixtures/test';
import { resetData, selectModel } from './helpers';
import { DatabaseSync } from 'node:sqlite';
import { resolve } from 'node:path';

// Inline rather than an import statement: specs are barred from importing
// '@playwright/test' (fixtures/test.ts adds the server-error check), and the ban
// is path-wide, so even a type-only import trips it.
type Page = import('@playwright/test').Page;

const MOCK = 'http://127.0.0.1:3001';

test.beforeEach(() => {
	resetData();
});

/** What the upstream was last asked for. */
async function lastRequestedRatio(page: Page): Promise<string | null> {
	const res = await page.request.get(`${MOCK}/__last-image-request`);
	const body = (await res.json()) as { aspect_ratio?: string | null };
	return body.aspect_ratio ?? null;
}

const selector = (page: Page) => page.getByRole('button', { name: /^Aspect ratio/ });

async function gotoNewChat(page: Page): Promise<void> {
	await page.goto('/');
	await expect(page.getByRole('button', { name: 'Select model' })).toContainText('Mock Chat');
}

test('the selector appears only for a model that advertises ratios', async ({ page }) => {
	await gotoNewChat(page);
	// Mock Chat advertises none — absence must read as "no selector", not as a
	// disabled control or a default of 1:1.
	await expect(selector(page)).toHaveCount(0);

	await selectModel(page, /Mock Image/);
	await expect(selector(page)).toBeVisible();

	// And it goes away again when the selection moves back to a chat model, so a
	// stale value can't ride a send the control isn't shown for.
	await selectModel(page, /Mock Chat$/);
	await expect(selector(page)).toHaveCount(0);
});

test('it opens on Default and sends what was picked', async ({ page }) => {
	await gotoNewChat(page);
	await selectModel(page, /Mock Image/);
	// Default, not mock-image's advertised 1:1 as a concrete pick: "no preference"
	// has to stay expressible, since it is the only way to say "let each model use
	// its own" — see the fan-out test below.
	await expect(selector(page)).toContainText('Default');

	await selector(page).click();
	await page.getByRole('button', { name: /^16:9/ }).click();
	await expect(selector(page)).toContainText('16:9');

	await page.locator('textarea').first().fill('a lighthouse');
	const send = page.getByRole('button', { name: 'Send message' });
	await expect(send).toBeEnabled();
	await send.click();

	// The first generation in a new chat hands off through sessionStorage rather
	// than turn.send, so this is also the regression guard for that path.
	await page.waitForURL(/\/chat\/[^/]+$/);
	await expect(page.locator('img[src*="/api/media/"]').first()).toBeVisible();
	expect(await lastRequestedRatio(page)).toBe('16:9');
});

test('a label-less ratio renders without a placeholder', async ({ page }) => {
	await gotoNewChat(page);
	await selectModel(page, /Mock Image/);
	await selector(page).click();
	// mock-image's 4:3 deliberately carries no label; the option shows the ratio
	// alone rather than inventing a name for it.
	const option = page.getByRole('button', { name: /^4:3/ });
	await expect(option).toBeVisible();
	await expect(option).toHaveText('4:3');
});

test('a pick survives a reload and a change of model', async ({ page }) => {
	await gotoNewChat(page);
	await selectModel(page, /Mock Image/);
	await selector(page).click();
	await page.getByRole('button', { name: /^3:2/ }).click();
	await expect(selector(page)).toContainText('3:2');

	// Remembered across a reload, so the next prompt opens on the same shape
	// rather than back on the model's default. The new-chat page doesn't persist
	// the model itself, so re-pick it — the point here is the ratio, which comes
	// from localStorage rather than from anything on the page.
	await page.reload();
	await expect(page.getByRole('button', { name: 'Select model' })).toContainText('Mock Chat');
	await selectModel(page, /Mock Image/);
	await expect(selector(page)).toContainText('3:2');

	// Mock Painter offers only 1:1 and 9:16. The remembered 3:2 isn't on its
	// menu, so the control must show the nearest thing it CAN do (1:1) rather
	// than keep displaying a ratio this model would never render.
	await selectModel(page, /Mock Painter/);
	await expect(selector(page)).toContainText('1:1');

	// And the preference itself is untouched — going back offers 3:2 again,
	// because only a deliberate pick rewrites it.
	await selectModel(page, /Mock Image/);
	await expect(selector(page)).toContainText('3:2');
});

test('comparing two models offers the union of their menus', async ({ page }) => {
	await gotoNewChat(page);
	await selectModel(page, /Mock Image/);

	// Mock Image has 1:1/3:2/4:3/16:9; Mock Painter has 1:1/9:16. They overlap on
	// 1:1 alone, so an intersection would collapse the menu to one row. The union
	// is what's correct: each model snaps the chosen ratio against its own list
	// upstream, so offering a ratio only one of them knows costs nothing.
	await page.getByRole('button', { name: 'Select model' }).click();
	await page.getByRole('button', { name: 'Multiple' }).click();
	await page.getByRole('option', { name: /Mock Painter/ }).click();
	await page.keyboard.press('Escape');

	await selector(page).click();
	for (const ratio of ['1:1', '3:2', '4:3', '16:9', '9:16']) {
		await expect(page.getByRole('button', { name: new RegExp(`^${ratio}`) })).toBeVisible();
	}
});

test('a fan-out sends the picked ratio on its branches', async ({ page }) => {
	await gotoNewChat(page);
	await selectModel(page, /Mock Image/);
	await selector(page).click();
	await page.getByRole('button', { name: /^16:9/ }).click();

	// Two image models, one shape. Mock Painter's menu has no 16:9 — the point is
	// that the branch still carries it and the upstream resolves it, rather than
	// the client filtering it out and leaving that model on its own default.
	await page.getByRole('button', { name: 'Select model' }).click();
	await page.getByRole('button', { name: 'Multiple' }).click();
	await page.getByRole('option', { name: /Mock Painter/ }).click();
	await page.keyboard.press('Escape');

	await page.locator('textarea').first().fill('a lighthouse');
	const send = page.getByRole('button', { name: /Send to 2 models/ });
	await expect(send).toBeEnabled();
	await send.click();

	await page.waitForURL(/\/chat\/[^/]+$/);
	// Both branches settle into the compare grid.
	await expect(page.locator('img[src*="/api/media/"]')).toHaveCount(2, { timeout: 15000 });
	expect(await lastRequestedRatio(page)).toBe('16:9');
});

test('the rendered ratio is persisted and shown in the lightbox', async ({ page }) => {
	await gotoNewChat(page);
	await selectModel(page, /Mock Image/);
	await selector(page).click();
	await page.getByRole('button', { name: /^3:2/ }).click();

	await page.locator('textarea').first().fill('a lighthouse');
	await page.getByRole('button', { name: 'Send message' }).click();
	await page.waitForURL(/\/chat\/[^/]+$/);
	await expect(page.locator('img[src*="/api/media/"]').first()).toBeVisible();
	await expect(page.getByRole('button', { name: 'Send message' })).toBeVisible();

	// What the UPSTREAM echoed lands on the media row — not what was requested.
	// They agree here; the point is that the column is written at all.
	const db = new DatabaseSync(resolve('./tests/.e2e-data/test.db'));
	try {
		const row = db
			.prepare(
				"SELECT aspect_ratio FROM media WHERE origin = 'generated' ORDER BY created_at DESC LIMIT 1",
			)
			.get() as { aspect_ratio: string | null } | undefined;
		expect(row?.aspect_ratio).toBe('3:2');
	} finally {
		db.close();
	}

	// That it then READS OUT in the lightbox is covered by
	// tests/component/MediaLightbox.test.ts — driving the gallery to an open
	// lightbox on two viewports proved flaky for no extra coverage.
});

test('an edited prompt resends at the same shape, not the workflow default', async ({ page }) => {
	// The composer — and with it the shape control — is unmounted during an edit,
	// so a dropped ratio is invisible: the regeneration just comes back reframed.
	// This is the one send path of seven that was missing it.
	await gotoNewChat(page);
	await selectModel(page, /Mock Image/);
	await selector(page).click();
	await page.getByRole('button', { name: /^16:9/ }).click();

	await page.locator('textarea').first().fill('a lighthouse');
	await page.getByRole('button', { name: 'Send message' }).click();
	await page.waitForURL(/\/chat\/[^/]+$/);
	await expect(page.locator('img[src*="/api/media/"]').first()).toBeVisible();
	await expect(page.getByRole('button', { name: 'Send message' })).toBeVisible();
	expect(await lastRequestedRatio(page)).toBe('16:9');

	// Reword the prompt and resend.
	await page.getByRole('button', { name: 'Edit message' }).click();
	const editor = page.locator('article', { hasText: 'Editing' });
	await editor.locator('textarea').fill('a tall lighthouse');
	await page.getByRole('button', { name: 'Save' }).click();
	await expect(page.getByRole('button', { name: 'Send message' })).toBeVisible();

	// Still 16:9 — before the fix this went out with no aspect_ratio at all.
	expect(await lastRequestedRatio(page)).toBe('16:9');
});

test('Default sends no ratio, so each model uses its own', async ({ page }) => {
	// The case the Default entry exists for: any concrete pick is imposed on every
	// fan-out branch, so "let each model decide" is only expressible by sending
	// nothing. mock-image defaults to 1:1 and mock-painter to 9:16.
	await gotoNewChat(page);
	await selectModel(page, /Mock Image/);

	// A remembered preference would otherwise make this unreachable — pick one
	// first so Default is a genuine return, not just the initial state.
	await selector(page).click();
	await page.getByRole('button', { name: /^16:9/ }).click();
	await expect(selector(page)).toContainText('16:9');

	await selector(page).click();
	await page.getByRole('button', { name: /^Default/ }).click();
	await expect(selector(page)).toContainText('Default');

	await page.locator('textarea').first().fill('a lighthouse');
	await page.getByRole('button', { name: 'Send message' }).click();
	await page.waitForURL(/\/chat\/[^/]+$/);
	await expect(page.locator('img[src*="/api/media/"]').first()).toBeVisible();
	await expect(page.getByRole('button', { name: 'Send message' })).toBeVisible();

	// Nothing on the wire — the upstream falls back to its own default.
	expect(await lastRequestedRatio(page)).toBeNull();
});

test('Default is labelled with the shape when the models agree, and not when they do not', async ({
	page,
}) => {
	await gotoNewChat(page);
	await selectModel(page, /Mock Image/);
	await selector(page).click();
	// One model selected, so its default is nameable.
	await expect(page.getByRole('button', { name: /^Default/ })).toContainText("The model's own");
	await page.keyboard.press('Escape');

	// Add a model whose default differs (1:1 vs 9:16) — naming either would be
	// wrong for the other, so it falls back to the generic label.
	await page.getByRole('button', { name: 'Select model' }).click();
	await page.getByRole('button', { name: 'Multiple' }).click();
	await page.getByRole('option', { name: /Mock Painter/ }).click();
	await page.keyboard.press('Escape');

	await selector(page).click();
	await expect(page.getByRole('button', { name: /^Default/ })).toContainText("Each model's own");
});

test('a ratio written into the prompt selects itself and reaches the upstream', async ({
	page,
}) => {
	await gotoNewChat(page);
	await selectModel(page, /Mock Image/);
	await expect(selector(page)).toContainText('Default');

	// Never touches the control: the shape is stated in the prose, which is the
	// whole point. 16:9 is deliberately NOT mock-image's advertised default (1:1),
	// so what lands upstream can only have come from the text.
	await page.locator('textarea').first().fill('a 16:9 photo of a lighthouse');
	await expect(selector(page)).toContainText('16:9');
	// And it says why, since this is a change the user didn't make by hand.
	await expect(page.getByRole('button', { name: /found in your prompt/i })).toBeVisible();

	const send = page.getByRole('button', { name: 'Send message' });
	await expect(send).toBeEnabled();
	await send.click();
	await page.waitForURL(/\/chat\/[^/]+$/);
	await expect(page.locator('img[src*="/api/media/"]').first()).toBeVisible();
	expect(await lastRequestedRatio(page)).toBe('16:9');
});

test('a clock in the prompt is not a shape request', async ({ page }) => {
	// The false positive the exact-match rule exists to kill: 3:45 is a well-formed
	// W:H that would snap to something if snapping were allowed here.
	await gotoNewChat(page);
	await selectModel(page, /Mock Image/);
	await page.locator('textarea').first().fill('a station clock showing 3:45');
	// Proving a NON-event, so there is no state transition to await: a web-first
	// assertion retries until it first holds, and "absent" already holds, so it
	// would return within a few ms and pass even against a detector that was about
	// to fire. Outwaiting the detection debounce is the only thing that makes this
	// assertion — and the Send below, which would otherwise also land inside the
	// window — mean anything.
	await page.waitForTimeout(500);
	await expect(page.getByRole('button', { name: /found in your prompt/i })).toHaveCount(0);
	await expect(selector(page)).toContainText('Default');

	await page.getByRole('button', { name: 'Send message' }).click();
	await page.waitForURL(/\/chat\/[^/]+$/);
	await expect(page.locator('img[src*="/api/media/"]').first()).toBeVisible();
	expect(await lastRequestedRatio(page)).toBeNull();
});

test('picking a shape by hand outranks the one in the prompt', async ({ page }) => {
	await gotoNewChat(page);
	await selectModel(page, /Mock Image/);
	await page.locator('textarea').first().fill('a 16:9 photo of a lighthouse');
	await expect(selector(page)).toContainText('16:9');

	await selector(page).click();
	await page.getByRole('button', { name: /^3:2/ }).click();
	await expect(selector(page)).toContainText('3:2');
	await expect(page.getByRole('button', { name: /found in your prompt/i })).toHaveCount(0);

	// Keep typing with the same ratio still sitting in the text: an unoverridable
	// detection would re-assert itself here, which is the bug worth an e2e guard.
	await page.locator('textarea').first().fill('a 16:9 photo of a lighthouse at dusk');
	// Same non-event problem as the clock test — the trigger ALREADY reads 3:2, so
	// asserting it without outwaiting the debounce this edit just re-armed would
	// pass against the very regression the test is named for.
	await page.waitForTimeout(500);
	await expect(selector(page)).toContainText('3:2');

	await page.getByRole('button', { name: 'Send message' }).click();
	await page.waitForURL(/\/chat\/[^/]+$/);
	await expect(page.locator('img[src*="/api/media/"]').first()).toBeVisible();
	expect(await lastRequestedRatio(page)).toBe('3:2');
});

test('a ratio typed just before Enter still reaches the upstream', async ({ page }) => {
	// Real keystrokes then Enter, with no assertion in between — every other test
	// here awaits the picker settling before it sends, which is precisely why none
	// of them can see this: the ratio is trailing, so it exists only in the snapshot
	// the debounce is still holding when the send reads the value.
	//
	// What this test guarantees is narrower than "it cannot wait the debounce out",
	// because this page never clears the box: the pending timer is not cancelled,
	// it merely RACES `POST /api/conversations`, and a create slow enough to outlast
	// the debounce would let the detection land on its own. The margin is wide for a
	// local SQLite insert, but it is a margin — and it degrades to a silent PASS
	// rather than a failure. The follow-up-turn test below is the unconditional one.
	await gotoNewChat(page);
	await selectModel(page, /Mock Image/);

	const box = page.locator('textarea').first();
	await box.click();
	await box.pressSequentially('a lighthouse at dusk, 16:9', { delay: 15 });
	await page.keyboard.press('Enter');

	await page.waitForURL(/\/chat\/[^/]+$/);
	await expect(page.locator('img[src*="/api/media/"]').first()).toBeVisible();
	expect(await lastRequestedRatio(page)).toBe('16:9');
});

test('a trailing ratio survives Enter on a follow-up turn too', async ({ page }) => {
	// The unconditional twin of the test above. On an existing conversation the send
	// clears the composer BEFORE reading the ratio, and clearing it tears down the
	// pending debounce timer outright — so the detection can never land on its own
	// and this can only pass if the flush ran. No latency to race, on any machine.
	//
	// Asserted on the REQUEST the client sends, not on `lastRequestedRatio`: a
	// follow-up turn in an image conversation auto-attaches the previous
	// generation, so it goes upstream as image-to-image and the mock's
	// text-to-image recorder never sees it. The claim under test is that the
	// composer commits the ratio before the body is built, and the body is exactly
	// where that is observable. The upstream leg is covered by the tests above.
	const sent: Array<{ aspectRatio?: string }> = [];
	page.on('request', (r) => {
		if (r.method() === 'POST' && /\/api\/conversations\/[^/]+\/messages/.test(r.url())) {
			sent.push(JSON.parse(r.postData() ?? '{}') as { aspectRatio?: string });
		}
	});

	await gotoNewChat(page);
	await selectModel(page, /Mock Image/);

	// Turn one establishes the conversation on an image model. Deliberately names no
	// ratio and picks none: a pick would write the remembered preference, which
	// would then supply 16:9 on turn two for the wrong reason and pass against a
	// deleted flush.
	await page.locator('textarea').first().fill('a lighthouse');
	await page.getByRole('button', { name: 'Send message' }).click();
	await page.waitForURL(/\/chat\/[^/]+$/);
	const rendered = page.locator('article img[src*="/api/media/"]');
	await expect(rendered).toHaveCount(1, { timeout: 15000 });
	expect(sent.at(-1)?.aspectRatio).toBeUndefined();
	await expect(selector(page)).toBeVisible();

	// Turn two: trailing ratio, Enter, nothing in between.
	const box = page.locator('textarea').first();
	await box.click();
	await box.pressSequentially('a tall lighthouse, 16:9', { delay: 15 });
	await page.keyboard.press('Enter');

	await expect(rendered).toHaveCount(2, { timeout: 15000 });
	// Two requests, and it is the SECOND one being measured — turn one is already
	// pinned above as carrying no ratio at all.
	expect(sent).toHaveLength(2);
	expect(sent[1].aspectRatio).toBe('16:9');
});

test('the send button stays inside the composer when the row is crowded', async ({ page }) => {
	// A narrow phone with the shape selector present is the crowded case: attach,
	// feature toggles, the selector, the model picker and send all share one
	// non-wrapping row. The picker is the only elastic thing there, and a flex item
	// defaults to refusing to shrink below its content — so without `min-w-0` it
	// held its full width, the row overflowed, and the send button (or the Stop
	// button during a generation, same box) was pushed outside the rounded panel
	// and off the edge of the screen.
	await page.setViewportSize({ width: 320, height: 720 });
	await gotoNewChat(page);
	await selectModel(page, /Mock Image/);
	await expect(selector(page)).toBeVisible();

	const overflow = await page.evaluate(() => {
		const row = document.querySelector('form div.flex.items-center.gap-2');
		const form = document.querySelector('form');
		const send = document.querySelector('button[aria-label^="Send"], button[aria-label^="Stop"]');
		if (!row || !form || !send) return null;
		return {
			row: row.scrollWidth - row.clientWidth,
			pastEdge: Math.round(send.getBoundingClientRect().right - form.getBoundingClientRect().right),
		};
	});
	expect(overflow).not.toBeNull();
	// The row must not scroll, and the control must sit inside the panel that draws
	// the composer's border — not merely inside the viewport.
	expect(overflow!.row).toBe(0);
	expect(overflow!.pastEdge).toBeLessThanOrEqual(0);
});

/** Width of the trigger's shape glyph, or -1 when the control isn't rendered. */
async function glyphWidth(page: Page): Promise<number> {
	return page.evaluate(() => {
		const svg = document.querySelector('button[aria-label^="Aspect ratio"]')?.querySelector('svg');
		return svg ? Math.round(svg.getBoundingClientRect().width) : -1;
	});
}

test('the glyph yields to a long model name, and only to a long one', async ({ page }) => {
	// The glyph is the half of this control that can go: the label beside it says
	// the same thing, and at a 13px box 16:9 / 3:2 / 4:3 differ by about a pixel
	// and a half. But it only goes when something is actually squeezing the name —
	// dropping it on a phone showing "Krea 2" would cost legibility and buy nothing.
	await page.setViewportSize({ width: 393, height: 800 });
	await gotoNewChat(page);

	// Mock Image is short enough to fit, so the glyph stays even on a phone.
	await selectModel(page, /Mock Image/);
	await expect(selector(page)).toBeVisible();
	expect(await glyphWidth(page)).toBeGreaterThan(0);

	// Mock Painter's name is long enough to start truncating; the glyph yields.
	await selectModel(page, /Mock Painter/);
	await expect(selector(page)).toBeVisible();
	expect(await glyphWidth(page)).toBe(0);

	// Given room, the long name keeps the glyph too — the drop is a response to
	// pressure, not a permanent amputation.
	await page.setViewportSize({ width: 900, height: 800 });
	await expect(selector(page)).toBeVisible();
	expect(await glyphWidth(page)).toBeGreaterThan(0);
});
