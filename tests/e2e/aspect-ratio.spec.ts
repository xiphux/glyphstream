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

test('it opens on the model default and sends what was picked', async ({ page }) => {
	await gotoNewChat(page);
	await selectModel(page, /Mock Image/);
	// mock-image reports aspect_ratio_default "1:1", so that is the opening
	// selection — the control is never blank while it's visible.
	await expect(selector(page)).toContainText('1:1');

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
