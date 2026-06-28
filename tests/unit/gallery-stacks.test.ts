import { describe, expect, it } from 'vitest';
import { ORPHAN_GAP_MS, groupGalleryItems, promptRunKey } from '$lib/gallery-stacks';
import type { MediaListItem } from '$lib/server/db/queries/media';

// Items are newest-first (descending createdAt), matching the gallery stream.
// `t` is a "minutes ago" offset so larger = older; we negate into createdAt.
function item(
	id: string,
	opts: {
		conversationId?: string | null;
		conversationTitle?: string | null;
		promptFull?: string | null;
		originalPrompt?: string | null;
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
		originalPrompt: opts.originalPrompt ?? null,
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

	it('stacks an enhanced fan-out by the shared original prompt despite divergent promptFull', () => {
		// Prompt enhancement rewrites each branch differently, so promptFull
		// diverges per model — but they share the user's originalPrompt and must
		// still stack once the conversation is gone. The non-enhanced branch
		// (originalPrompt null) falls back to its promptFull, which equals the
		// user's prompt, so it joins too.
		const items = [
			item('a', {
				promptFull: '1girl, solo, forest',
				originalPrompt: 'a girl in a forest',
				minutesAgo: 0,
			}),
			item('b', {
				promptFull: 'a girl standing in a sunlit forest, cinematic',
				originalPrompt: 'a girl in a forest',
				minutesAgo: 0,
			}),
			item('c', { promptFull: 'a girl in a forest', minutesAgo: 1 }),
		];
		const groups = groupGalleryItems(items);
		expect(groups).toHaveLength(1);
		expect(groups[0].kind).toBe('prompt');
		expect(groups[0].items.map((i) => i.id)).toEqual(['a', 'b', 'c']);
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

	it('buckets a conversation globally even when interleaved with another (A-B-A)', () => {
		// Generated in chat A, then B, then back in A → stream order A2, B1, A1.
		// A consecutive-run grouping would emit two "A" groups with the same key
		// and crash the keyed {#each}; global bucketing keeps A a single, complete
		// stack.
		const items = [
			item('a2', { conversationId: 'convA', conversationTitle: 'Chat A', minutesAgo: 0 }),
			item('b1', { conversationId: 'convB', conversationTitle: 'Chat B', minutesAgo: 1 }),
			item('a1', { conversationId: 'convA', conversationTitle: 'Chat A', minutesAgo: 2 }),
		];
		const groups = groupGalleryItems(items);
		expect(groups).toHaveLength(2);
		// Group order follows each conversation's newest member.
		expect(groups[0].conversationId).toBe('convA');
		expect(groups[0].kind).toBe('conversation');
		expect(groups[0].items.map((i) => i.id)).toEqual(['a2', 'a1']); // complete, not truncated
		expect(groups[0].title).toBe('Chat A');
		expect(groups[1].conversationId).toBe('convB');
		expect(groups[1].kind).toBe('solo'); // single appearance
		// No duplicate keys → the gallery {#each (g.key)} can't collide.
		expect(new Set(groups.map((g) => g.key)).size).toBe(groups.length);
	});

	it('keeps keys unique for distinct single-appearance conversations', () => {
		const items = [item('a', { conversationId: 'convA' }), item('b', { conversationId: 'convB' })];
		const groups = groupGalleryItems(items);
		expect(groups.map((g) => g.kind)).toEqual(['solo', 'solo']);
		expect(new Set(groups.map((g) => g.key)).size).toBe(2);
	});

	it('a conversation item between two same-prompt orphans breaks the run', () => {
		const items = [
			item('o1', { promptFull: 'a cat' }),
			item('c', { conversationId: 'convA', promptFull: 'a cat' }),
			item('o2', { promptFull: 'a cat' }),
		];
		const groups = groupGalleryItems(items);
		// o1 (solo), convA (solo), o2 (solo) — the orphans never merge across the
		// conversation item.
		expect(groups.map((g) => g.items[0].id)).toEqual(['o1', 'c', 'o2']);
		expect(new Set(groups.map((g) => g.key)).size).toBe(3);
	});

	it('promptRunKey anchors to the leader id', () => {
		expect(promptRunKey('xyz')).toBe('p:xyz');
		const groups = groupGalleryItems([
			item('a', { promptFull: 'p' }),
			item('b', { promptFull: 'p' }),
		]);
		expect(groups[0].key).toBe(promptRunKey('a'));
	});
});
