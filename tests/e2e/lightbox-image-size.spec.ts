import { test, expect } from './fixtures/test';
import { generateImageFromHome, resetData, seedMediaPrompts, sendFollowup } from './helpers';

/**
 * The lightbox shows a display-sized copy (`/display`, through a srcset over the
 * size ladder) rather than the original (`/content`), from every page that opens
 * it.
 *
 * An e2e because what can break is the seam: each host turns its own data into
 * carousel slides (the chat's conversation media refs, the gallery's unit
 * leaders), and a slide without a size falls back to the original. Nothing
 * looks wrong when that happens — the lightbox just goes back to downloading
 * full originals — so no unit or component test of the pieces would notice a
 * host that stopped passing it. WHICH copy a given screen picks is browser
 * policy and is not asserted here; the mock's images are 1×1, so the ladder is a
 * single candidate.
 */

const LIGHTBOX_IMG = '[role="dialog"] img[srcset]';

test.beforeEach(() => resetData());

test('the chat lightbox loads display copies, never the original', async ({ page }) => {
	await generateImageFromHome(page, 'a lighthouse at dusk');
	// A second result, so the lightbox is a carousel built from the
	// conversation's media refs rather than the one opened row. The follow-up
	// auto-attaches the first image, which would make it an edit (and the mock
	// has no /images/edits): drop the attachment so it's a fresh generation.
	await page.getByRole('button', { name: 'Remove attachment' }).click();
	await sendFollowup(page, 'the same lighthouse at dawn');

	const loaded: string[] = [];
	page.on('request', (r) => {
		const path = new URL(r.url()).pathname;
		if (/^\/api\/media\/[^/]+\/(content|display)$/.test(path)) loaded.push(path);
	});
	await page.getByRole('button', { name: 'Open image' }).first().click();

	const slides = page.locator(LIGHTBOX_IMG);
	await expect(slides).toHaveCount(2);
	for (const slide of await slides.all()) {
		await expect(slide).toHaveAttribute('srcset', /\/api\/media\/[^/ ]+\/display \d+w/);
	}
	// What the browser actually fetched for the slide on screen.
	const shown = slides.first();
	await expect
		.poll(() => shown.evaluate((img: HTMLImageElement) => img.currentSrc))
		.toMatch(/\/display$/);
	expect(loaded.filter((p) => p.endsWith('/content'))).toEqual([]);
});

test('the gallery lightbox sizes its slides from the grid', async ({ page }) => {
	seedMediaPrompts(['a red kite', 'a blue kite', 'a green kite'], { width: 3000, height: 2000 });
	await page.goto('/gallery');
	await page.locator('li[data-tile] img[src*="/api/media/"]').first().click();

	// Three separate prompts are three solo units, so every slide comes from a
	// unit leader. 3000 px is past the top size: the whole ladder, then the original.
	const slides = page.locator(LIGHTBOX_IMG);
	await expect(slides).toHaveCount(3);
	for (const slide of await slides.all()) {
		await expect(slide).toHaveAttribute(
			'srcset',
			/\/display 1280w, \S+\/display\?size=2048 2048w, \S+\/content 3000w$/,
		);
		await expect(slide).toHaveAttribute('src', /\/display$/);
	}
});
