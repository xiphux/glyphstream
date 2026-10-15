/**
 * Every carousel host must wire `onPrefetch` on its <MediaLightbox>.
 *
 * A swipe resolves its slide at the midpoint, and while the caller fetches that
 * row the lightbox disables the per-image actions rather than offer them for the
 * image the user left. That's only invisible if the row is already in hand —
 * which is what `onPrefetch` is for. A host that passes `onNavigate` without it
 * still works, so nothing else notices: it type-checks (the prop is optional),
 * the component tests pass the prop themselves, and `ChatLightbox.prefetch` is
 * unit-tested by calling it directly. The chat page shipped exactly that way —
 * every swipe there waited a round trip behind a disabled header.
 *
 * A host whose `onNavigate` never fetches has nothing to warm, and is listed in
 * EXEMPT with the reason.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';

const ROUTES = resolve(__dirname, '../../src/routes');

const HOSTS = ['(app)/chat/[id]/+page.svelte', '(app)/gallery/+page.svelte'];

const EXEMPT: Record<string, string> = {
	// Navigation is `viewingId = id` over rows the page already holds.
	'(app)/gallery/trash/+page.svelte': 'onNavigate swaps between rows already in memory',
};

/** The opening tag of each <MediaLightbox …/> in a file. */
function lightboxTags(source: string): string[] {
	return [...source.matchAll(/<MediaLightbox\b[\s\S]*?\/>/g)].map((m) => m[0]);
}

describe('MediaLightbox carousel hosts wire onPrefetch', () => {
	it.each(HOSTS)('%s', (file) => {
		const tags = lightboxTags(readFileSync(resolve(ROUTES, file), 'utf8'));
		expect(tags.length, 'no <MediaLightbox> found — has the host moved?').toBeGreaterThan(0);
		for (const tag of tags.filter((t) => /\bonNavigate=/.test(t))) {
			expect(tag).toMatch(/\bonPrefetch=/);
		}
	});

	it('lists every host, so a new one is checked or exempted on purpose', () => {
		const found = readdirSync(ROUTES, { recursive: true, encoding: 'utf8' })
			.filter((f) => f.endsWith('.svelte'))
			.filter((f) => lightboxTags(readFileSync(resolve(ROUTES, f), 'utf8')).length > 0)
			.map((f) => relative(ROUTES, resolve(ROUTES, f)))
			.sort();
		expect(found).toEqual([...HOSTS, ...Object.keys(EXEMPT)].sort());
	});
});
