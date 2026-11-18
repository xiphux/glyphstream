import { describe, expect, it } from 'vitest';
import { GalleryFeed } from '#lib/gallery-feed.svelte.js';
import type { GalleryLayout, GalleryUnit } from '#lib/types/api.js';

/**
 * The feed pages by absolute offset against a layout fetched once. A media row
 * landing (or going) after the seed shifts every later offset, so a page
 * demand-loaded afterwards repeats the previous page's tail. The page response
 * carries the server's current total; a mismatch must ask the page to reseed,
 * and the lightbox's sibling set (keyed by id) must never hold a leader twice.
 */
function unit(n: number): GalleryUnit {
	return {
		key: `p:m-${n}`,
		groupKind: 'solo',
		leaderId: `m-${n}`,
		leaderKind: 'image',
		leaderWidth: null,
		leaderHeight: null,
		createdAt: 1_000_000 - n,
		dayKey: '2026-06-15',
		memberCount: 1,
		favoriteCount: 0,
		previews: [{ id: `m-${n}`, kind: 'image' }],
		excerpt: null,
		label: '',
		conversationId: null,
		title: null,
	};
}

function setup(count: number) {
	const state = { library: Array.from({ length: count }, (_, i) => unit(i)), stale: 0 };
	const feed = new GalleryFeed({
		fetchPage: (offset, limit) =>
			Promise.resolve({
				units: state.library.slice(offset, offset + limit),
				total: state.library.length,
			}),
		onStale: () => state.stale++,
	});
	const layout: GalleryLayout = { days: [{ key: '2026-06-15', units: count }], totalUnits: count };
	feed.seed(layout, state.library.slice(0, GalleryFeed.PAGE));
	return { feed, state };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('GalleryFeed after the library changes mid-session', () => {
	it('never hands the lightbox the same leader twice', async () => {
		const { feed, state } = setup(240);
		state.library = [unit(-1), ...state.library];

		feed.ensureRange(120, 140);
		await flush();

		const ids = feed.loadedLeaders().map((s) => s.id);
		expect(new Set(ids).size).toBe(ids.length);
	});

	it('asks for a reseed once per observed total', async () => {
		const { feed, state } = setup(400);
		state.library = [unit(-1), ...state.library];

		feed.ensureRange(120, 140);
		await flush();
		expect(state.stale).toBe(1);

		feed.ensureRange(240, 260);
		await flush();
		expect(state.stale).toBe(1);
	});

	it('does not ask for a reseed while the library is unchanged', async () => {
		const { feed, state } = setup(240);
		feed.ensureRange(120, 140);
		await flush();
		expect(state.stale).toBe(0);
	});
});
