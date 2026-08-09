import process from 'node:process';
import { test, expect } from '@playwright/test';
import { resetData, seedSnippet } from './helpers';

/**
 * Prompt snippets: the insertion seam that only a real browser can prove.
 *
 * The component tests (tests/component/SnippetAutocomplete.test.ts) cover the
 * menu — opening, filtering, keyboard, caret tracking — but they run in
 * happy-dom, which has NO `document.execCommand`. Every insertion there falls
 * back to `setRangeText`, so the single most important property of this
 * feature is structurally unreachable in them:
 *
 *   inserting a snippet must be ONE undo unit, so a mis-picked snippet
 *   disappears on a single Ctrl-Z instead of character by character.
 *
 * That is the whole reason `replaceRange` uses the deprecated execCommand
 * rather than the modern setRangeText, so it gets a real-browser test here.
 * The import round-trip is covered by unit tests; these specs seed rows
 * directly and drive the composer.
 */

const STYLE_BODY = 'clean and highly readable linework, expressive forms';

test.beforeEach(() => {
	resetData();
	seedSnippet({
		id: 'e2e-snip-toriyama',
		name: 'Akira Toriyama Style',
		body: STYLE_BODY,
		kinds: ['image'],
		tags: ['anime'],
	});
	seedSnippet({ id: 'e2e-snip-terse', name: 'Terse Tone', body: 'No preamble. Answer directly.' });
});

/**
 * The new-chat composer on the home page — reachable without creating a
 * conversation or hitting an upstream model. Located structurally rather than
 * by placeholder: the placeholder text is modality-dependent ("How can I help
 * you today?" vs "Describe an image to generate…"), so it would couple these
 * specs to whichever model the e2e environment happens to default to.
 */
async function composer(page: import('@playwright/test').Page) {
	await page.goto('/');
	const ta = page.locator('form textarea').first();
	await expect(ta).toBeVisible();
	return ta;
}

test.describe('prompt snippets: insertion', () => {
	test('inserts the body at the caret, preserving surrounding text', async ({ page }) => {
		const ta = await composer(page);
		await ta.click();
		await ta.pressSequentially('Style: ;tori');

		await expect(page.getByRole('listbox', { name: 'Prompt snippets' })).toBeVisible();
		await expect(page.getByRole('option')).toHaveCount(1);
		await page.keyboard.press('Enter');

		await expect(ta).toHaveValue(`Style: ${STYLE_BODY}`);
		// Selecting completes only — it must never submit the turn.
		await expect(page).toHaveURL('/');
	});

	/**
	 * The reason execCommand is used at all. A native undo entry means the
	 * whole inserted block reverts in one step, back to the partial query, so
	 * the user can immediately re-pick. With setRangeText this would either do
	 * nothing or unwind character by character.
	 */
	test('a single Ctrl-Z removes the whole inserted block', async ({ page }) => {
		const ta = await composer(page);
		await ta.click();
		await ta.pressSequentially('Style: ;tori');
		await expect(page.getByRole('listbox', { name: 'Prompt snippets' })).toBeVisible();
		await page.keyboard.press('Enter');
		await expect(ta).toHaveValue(`Style: ${STYLE_BODY}`);

		const undo = process.platform === 'darwin' ? 'Meta+z' : 'Control+z';
		await page.keyboard.press(undo);

		await expect(ta).toHaveValue('Style: ;tori');
	});

	test('stacks several snippets in one prompt', async ({ page }) => {
		const ta = await composer(page);
		await ta.click();
		await ta.pressSequentially(';tori');
		await expect(page.getByRole('listbox', { name: 'Prompt snippets' })).toBeVisible();
		await page.keyboard.press('Enter');
		await ta.pressSequentially(' ;terse');
		await expect(page.getByRole('listbox', { name: 'Prompt snippets' })).toBeVisible();
		await page.keyboard.press('Enter');

		await expect(ta).toHaveValue(`${STYLE_BODY} No preamble. Answer directly.`);
	});

	test('clicking an option inserts it and keeps focus in the textarea', async ({ page }) => {
		const ta = await composer(page);
		await ta.click();
		await ta.pressSequentially(';terse');
		await page.getByRole('option').first().click();

		await expect(ta).toHaveValue('No preamble. Answer directly.');
		await expect(ta).toBeFocused();
	});

	test('Escape closes the menu without inserting', async ({ page }) => {
		const ta = await composer(page);
		await ta.click();
		await ta.pressSequentially(';tori');
		await expect(page.getByRole('listbox', { name: 'Prompt snippets' })).toBeVisible();

		await page.keyboard.press('Escape');
		await expect(page.getByRole('listbox', { name: 'Prompt snippets' })).toHaveCount(0);
		await expect(ta).toHaveValue(';tori');
	});

	// The reason `;` is safe to adopt as a trigger at all.
	test('an ordinary semicolon in prose or code never opens the menu', async ({ page }) => {
		const ta = await composer(page);
		await ta.click();
		await ta.pressSequentially('const x = 1; foo; bar');
		await expect(page.getByRole('listbox', { name: 'Prompt snippets' })).toHaveCount(0);
	});
});

test.describe('prompt snippets: settings', () => {
	test('imports a library, lists it, and exports it back', async ({ page }) => {
		await page.goto('/settings/snippets');
		await expect(page.getByRole('heading', { name: 'Prompt snippets' })).toBeVisible();

		await page
			.getByPlaceholder('## Akira Toriyama Style', { exact: false })
			.fill('## Cinematic Shot\nkinds: video\n\nsweeping crane move, shallow depth of field\n');
		await page.getByRole('button', { name: 'Import pasted text' }).click();

		await expect(page.getByText('Cinematic Shot')).toBeVisible();

		// The export must round-trip: what comes out re-imports cleanly.
		const res = await page.request.get('/api/user/prompt-snippets/export');
		expect(res.ok()).toBeTruthy();
		const body = await res.text();
		expect(body).toContain('## Cinematic Shot');
		expect(body).toContain('kinds: video');
	});

	// Regression: the import route answers 200 for "nothing parsed, but here's
	// why", so clearing the box on res.ok deleted the very library the user
	// needs to correct and retry — with no undo, since a programmatic value
	// assignment drops the textarea's native undo stack. The shape below (every
	// body written on its heading line) is the realistic hand-conversion slip.
	test('a failed paste import keeps the pasted text so it can be fixed', async ({ page }) => {
		await page.goto('/settings/snippets');
		const malformed = '## Style A: bold linework\n\n## Style B: soft pastel\n';
		const box = page.getByPlaceholder('## Akira Toriyama Style', { exact: false });
		await box.fill(malformed);

		// Wait for the import to actually answer before asserting anything.
		// A negative assertion does NOT auto-wait the way a positive one does:
		// `toHaveCount(0)` succeeds on its first poll, which lands before the
		// response, so asserting straight after the click proved nothing about
		// the import at all — it passed on a page that hadn't changed yet.
		const imported = page.waitForResponse((r) =>
			r.url().includes('/api/user/prompt-snippets/import'),
		);
		await page.getByRole('button', { name: 'Import pasted text' }).click();
		const res = await imported;

		// Take "nothing landed" from the server rather than from the absence of
		// a row, which is only ever absent-so-far.
		expect(await res.json()).toMatchObject({ imported: 0, updated: 0 });

		// The regression this test exists for: the box keeps its text so the
		// user can correct and retry.
		await expect(box).toHaveValue(malformed);

		// Scope the row check to the library list. The error toast NAMES every
		// skipped entry ("Style A: bold linework: no body"), so a page-wide
		// `getByText('Style A')` matches the report of the failure instead of a
		// row — which is exactly how this assertion used to fail once the toast
		// had time to render, while passing locally when it didn't.
		const rows = page.getByRole('main').getByRole('listitem');
		await expect(rows).toHaveCount(2); // the two seeded in beforeEach
		await expect(rows.filter({ hasText: 'Style A' })).toHaveCount(0);
	});

	test('a successful paste import clears the box', async ({ page }) => {
		await page.goto('/settings/snippets');
		const box = page.getByPlaceholder('## Akira Toriyama Style', { exact: false });
		await box.fill('## Good Snippet\n\na real body\n');
		await page.getByRole('button', { name: 'Import pasted text' }).click();

		await expect(page.getByText('Good Snippet')).toBeVisible();
		await expect(box).toHaveValue('');
	});

	test('a snippet created here is offered in the composer', async ({ page }) => {
		await page.goto('/settings/snippets');
		await page.getByRole('button', { name: 'New snippet' }).click();
		// exact: the import textarea's placeholder also *contains* these
		// strings (it shows a worked example), so a substring match is
		// ambiguous.
		await page.getByPlaceholder('Akira Toriyama Style', { exact: true }).fill('Watercolor Wash');
		await page
			.getByPlaceholder(
				'clean and highly readable linework, appealing character-focused design language…',
				{ exact: true },
			)
			.fill('soft pigment blooms, visible paper grain');
		await page.getByRole('button', { name: 'Create snippet' }).click();
		await expect(page.getByText('Watercolor Wash')).toBeVisible();

		const ta = await composer(page);
		await ta.click();
		await ta.pressSequentially(';watercolor');
		await expect(page.getByRole('listbox', { name: 'Prompt snippets' })).toBeVisible();
		await page.keyboard.press('Enter');
		await expect(ta).toHaveValue('soft pigment blooms, visible paper grain');
	});
});
