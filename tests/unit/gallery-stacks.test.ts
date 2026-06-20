import { describe, expect, it } from 'vitest';
import { ORPHAN_GAP_MS, groupGalleryItems } from '$lib/gallery-stacks';
import type { MediaListItem } from '$lib/server/db/queries/media';

// Items are newest-first (descending createdAt), matching the gallery stream.
// `t` is a "minutes ago" offset so larger = older; we negate into createdAt.
function item(
	id: string,
	opts: {
		conversationId?: string | null;
		conversationTitle?: string | null;
		promptFull?: string | null;
		minutesAgo?: number;
	} = {},
): MediaListItem {
	return {
		id,
		kind: 'image',
		contentType: 'image/webp',
		byteSize: 1,
		sourceEndpointId: null,
		sourceModel: null,
		promptExcerpt: opts.promptFull ?? null,
		promptFull: opts.promptFull ?? null,
		createdAt: -((opts.minutesAgo ?? 0) * 60_000),
		conversationId: opts.conversationId ?? null,
		conversationTitle: opts.conversationTitle ?? null,
	};
}

describe('groupGalleryItems', () => {
	it('returns an empty list for no items', () => {
		expect(groupGalleryItems([])).toEqual([]);
	});

	it('collapses a multi-model batch (same orphan prompt, adjacent) into one prompt stack', () => {
		const items = [
			item('a', { promptFull: 'a cat', minutesAgo: 0 }),
			item('b', { promptFull: 'a cat', minutesAgo: 0 }),
			item('c', { promptFull: 'a cat', minutesAgo: 1 }),
		];
		const groups = groupGalleryItems(items);
		expect(groups).toHaveLength(1);
		expect(groups[0].kind).toBe('prompt');
		expect(groups[0].items.map((i) => i.id)).toEqual(['a', 'b', 'c']);
		expect(groups[0].key).toBe('p:a');
	});

	it('groups items sharing a conversation, carrying its title', () => {
		const items = [
			item('a', { conversationId: 'conv1', conversationTitle: 'Logo ideas', minutesAgo: 0 }),
			item('b', { conversationId: 'conv1', conversationTitle: 'Logo ideas', minutesAgo: 5 }),
		];
		const groups = groupGalleryItems(items);
		expect(groups).toHaveLength(1);
		expect(groups[0].kind).toBe('conversation');
		expect(groups[0].conversationId).toBe('conv1');
		expect(groups[0].title).toBe('Logo ideas');
	});

	it('splits a same-prompt run when consecutive items are more than the gap apart', () => {
		const items = [
			item('a', { promptFull: 'a cat', minutesAgo: 0 }),
			item('b', { promptFull: 'a cat', minutesAgo: 0 }),
			// 90 minutes older than b — exceeds the 60-minute window.
			item('c', { promptFull: 'a cat', minutesAgo: 90 }),
			item('d', { promptFull: 'a cat', minutesAgo: 90 }),
		];
		const groups = groupGalleryItems(items);
		expect(groups).toHaveLength(2);
		expect(groups[0].items.map((i) => i.id)).toEqual(['a', 'b']);
		expect(groups[1].items.map((i) => i.id)).toEqual(['c', 'd']);
	});

	it('keeps a same-prompt run together exactly at the gap boundary', () => {
		const items = [
			item('a', { promptFull: 'a cat', minutesAgo: 0 }),
			item('b', { promptFull: 'a cat', minutesAgo: ORPHAN_GAP_MS / 60_000 }),
		];
		expect(groupGalleryItems(items)).toHaveLength(1);
	});

	it('splits a same-prompt run interrupted by a different prompt', () => {
		const items = [
			item('a', { promptFull: 'a cat' }),
			item('b', { promptFull: 'a dog' }),
			item('c', { promptFull: 'a cat' }),
		];
		const groups = groupGalleryItems(items);
		// Each is alone in its run → all demoted to solo.
		expect(groups.map((g) => g.kind)).toEqual(['solo', 'solo', 'solo']);
		expect(groups.map((g) => g.items[0].id)).toEqual(['a', 'b', 'c']);
	});

	it('marks a lone item as solo, keyed by its id', () => {
		const groups = groupGalleryItems([item('a', { promptFull: 'a cat' })]);
		expect(groups).toHaveLength(1);
		expect(groups[0].kind).toBe('solo');
		expect(groups[0].key).toBe('p:a');
	});

	it('does not merge a conversation item with an adjacent same-prompt orphan', () => {
		const items = [
			item('a', { conversationId: 'conv1', promptFull: 'a cat' }),
			item('b', { conversationId: null, promptFull: 'a cat' }),
		];
		const groups = groupGalleryItems(items);
		expect(groups).toHaveLength(2);
		expect(groups[0].conversationId).toBe('conv1');
		expect(groups[1].conversationId).toBeNull();
	});

	it('interleaves stacks and solos in true order', () => {
		const items = [
			item('a', { conversationId: 'conv1', conversationTitle: 'Chat A', minutesAgo: 0 }),
			item('b', { conversationId: 'conv1', conversationTitle: 'Chat A', minutesAgo: 1 }),
			item('solo', { promptFull: 'lone', minutesAgo: 2 }),
			item('x', { promptFull: 'batch', minutesAgo: 3 }),
			item('y', { promptFull: 'batch', minutesAgo: 3 }),
		];
		const groups = groupGalleryItems(items);
		expect(groups.map((g) => g.kind)).toEqual(['conversation', 'solo', 'prompt']);
		expect(groups[0].items.map((i) => i.id)).toEqual(['a', 'b']);
		expect(groups[1].items.map((i) => i.id)).toEqual(['solo']);
		expect(groups[2].items.map((i) => i.id)).toEqual(['x', 'y']);
	});

	it('never groups orphans with no prompt', () => {
		const items = [item('a', { promptFull: null }), item('b', { promptFull: null })];
		expect(groupGalleryItems(items).map((g) => g.kind)).toEqual(['solo', 'solo']);
	});
});
