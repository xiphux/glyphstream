import type { MediaListItem } from '$lib/server/db/queries/media';

/**
 * Gallery stacking groups related generated media so a multi-model fan-out or
 * a whole conversation's worth of revisions collapses into one card instead of
 * flooding the flat grid.
 *
 * Grouping is a single left-to-right pass over the gallery's existing
 * newest-first item stream — a *consecutive run*, not a global GROUP BY. Two
 * rules, in priority order:
 *
 *   1. Same conversation. Items still linked to a conversation
 *      (`conversationId != null`) group with adjacent siblings sharing that id.
 *   2. Same-prompt adjacency. The common case is media whose conversation was
 *      deleted (`conversationId == null`); a multi-model batch shares one exact
 *      prompt and lands back-to-back, so adjacent orphans with an identical
 *      `promptFull` group together. A time-gap guard (`ORPHAN_GAP_MS`) keeps a
 *      much-later re-generation of the same prompt from merging in.
 *
 * Anything matching neither rule (and any run of length 1) renders as a normal
 * solo tile, so the top level is a faithful, true-order mix of stacks and
 * singletons. Because it operates purely on the loaded `items` array, the
 * trailing group fills in live as more pages paginate in — items are only ever
 * appended to the correct run, never re-merged.
 */

/** Same-prompt orphan runs break once consecutive items are more than this far
 *  apart in time — a fan-out completes within seconds/minutes, so a re-gen of
 *  an old prompt "much later" stays a separate stack. */
export const ORPHAN_GAP_MS = 60 * 60 * 1000; // 1 hour

export interface GalleryGroup {
	/** Stable identity for drill-in / keyed rendering. Conversation groups use
	 *  the conversation id; prompt runs use `p:<first item id>`; solos use the
	 *  item id. */
	key: string;
	kind: 'conversation' | 'prompt' | 'solo';
	conversationId: string | null;
	/** Conversation title for `conversation` groups; null otherwise. */
	title: string | null;
	/** Members, newest-first (same order as the input stream). */
	items: MediaListItem[];
}

type Run = GalleryGroup & { kind: 'conversation' | 'prompt' };

/** Can `item` extend the current open run? */
function canJoin(run: Run, item: MediaListItem): boolean {
	if (item.conversationId != null) {
		// Conversation items only join a conversation run with the same id.
		return run.kind === 'conversation' && run.conversationId === item.conversationId;
	}
	// Orphan item: only joins a prompt run with the identical (non-empty)
	// prompt whose previous (newer) member is within the time-gap window.
	if (run.kind !== 'prompt') return false;
	const prompt = item.promptFull;
	if (!prompt || run.items[0]?.promptFull !== prompt) return false;
	const prev = run.items[run.items.length - 1];
	return prev.createdAt - item.createdAt <= ORPHAN_GAP_MS;
}

function startRun(item: MediaListItem): Run {
	if (item.conversationId != null) {
		return {
			key: item.conversationId,
			kind: 'conversation',
			conversationId: item.conversationId,
			title: item.conversationTitle,
			items: [item],
		};
	}
	return {
		key: `p:${item.id}`,
		kind: 'prompt',
		conversationId: null,
		title: null,
		items: [item],
	};
}

/**
 * Collapse a newest-first gallery item stream into stacks + solos. Pure; safe
 * to call on the accumulated `items` array on every change.
 */
export function groupGalleryItems(items: MediaListItem[]): GalleryGroup[] {
	const groups: Run[] = [];
	for (const item of items) {
		const open = groups[groups.length - 1];
		if (open && canJoin(open, item)) open.items.push(item);
		else groups.push(startRun(item));
	}
	// A run of one isn't a stack — demote to a solo tile.
	return groups.map((g): GalleryGroup => (g.items.length === 1 ? { ...g, kind: 'solo' } : g));
}
