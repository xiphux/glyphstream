import { describe, expect, it } from 'vitest';
import { GalleryFeed } from '$lib/gallery-feed.svelte';
import type { GalleryLayout, GalleryUnit } from '$lib/types/api';

/**
 * The gallery patches a tile's star badge in place instead of reseeding the grid:
 * a star moves `galleryUserFingerprint`, which drops the server's memoized
 * library, so a reseed per star would pay the full O(library) stacking pass to
 * move one badge — and starring is the action a user repeats in bursts.
 *
 * Plain value assertions, so the node environment is fine (no effects involved).
 */
function unit(overrides: Partial<GalleryUnit> = {}): GalleryUnit {
	return {
		key: 'u-1',
		groupKind: 'solo',
		leaderId: 'm-1',
		leaderKind: 'image',
		createdAt: 1000,
		dayKey: '2026-06-15',
		memberCount: 1,
		favoriteCount: 0,
		previews: [{ id: 'm-1', kind: 'image' }],
		excerpt: null,
		label: '',
		conversationId: null,
		title: null,
		...overrides,
	};
}

function seeded(units: GalleryUnit[]): GalleryFeed {
	const feed = new GalleryFeed({
		fetchPage: () => Promise.resolve({ units: [], total: units.length }),
	});
	const layout: GalleryLayout = {
		days: [{ key: '2026-06-15', units: units.length }],
		totalUnits: units.length,
	};
	feed.seed(layout, units);
	return feed;
}

describe('GalleryFeed.unitKeyForLeader', () => {
	it('maps a leader id to its unit key', () => {
		const feed = seeded([
			unit({ key: 'solo', leaderId: 'm-1' }),
			unit({ key: 'conv-9', leaderId: 'm-2', groupKind: 'conversation', memberCount: 3 }),
		]);
		expect(feed.unitKeyForLeader('m-2')).toBe('conv-9');
	});

	it('is undefined for a leader whose unit is not loaded', () => {
		// The unit map is sparse — only ranges near the viewport are held — so the
		// caller must tolerate a miss rather than assume every id resolves.
		expect(seeded([unit()]).unitKeyForLeader('never-loaded')).toBeUndefined();
	});
});

describe('GalleryFeed.patchUnitFavorite', () => {
	it('moves the badge count without touching anything else about the unit', () => {
		const before = unit({ key: 'conv-1', groupKind: 'conversation', memberCount: 4 });
		const feed = seeded([before]);
		feed.patchUnitFavorite('conv-1', 1);
		const after = feed.unitAt(0)!;
		expect(after.favoriteCount).toBe(1);
		// Everything a reseed would have re-derived is identical — which is the
		// premise the local patch rests on.
		expect({ ...after, favoriteCount: 0 }).toEqual(before);
	});

	it('clamps to the member count and to zero', () => {
		// The count is only ever nudged by ±1 from the true value, but a double
		// click or a revert racing a reseed must not leave a tile claiming more
		// favorites than it has members, or a negative count that reads as unstarred
		// when it is not.
		const feed = seeded([unit({ key: 'solo', memberCount: 1, favoriteCount: 1 })]);
		feed.patchUnitFavorite('solo', 1);
		expect(feed.unitAt(0)!.favoriteCount).toBe(1);
		feed.patchUnitFavorite('solo', -1);
		feed.patchUnitFavorite('solo', -1);
		expect(feed.unitAt(0)!.favoriteCount).toBe(0);
	});

	it('patches only the named unit', () => {
		const feed = seeded([unit({ key: 'a', leaderId: 'm-a' }), unit({ key: 'b', leaderId: 'm-b' })]);
		feed.patchUnitFavorite('b', 1);
		expect(feed.unitAt(0)!.favoriteCount).toBe(0);
		expect(feed.unitAt(1)!.favoriteCount).toBe(1);
	});

	it('is a no-op for an unloaded key rather than throwing', () => {
		const feed = seeded([unit({ key: 'a' })]);
		expect(() => feed.patchUnitFavorite('scrolled-away', 1)).not.toThrow();
		expect(feed.unitAt(0)!.favoriteCount).toBe(0);
	});
});
