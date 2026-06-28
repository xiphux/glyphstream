import type { MediaListItem } from '$lib/server/db/queries/media';

/**
 * Gallery stacking groups related generated media so a multi-model fan-out or
 * a whole conversation's worth of revisions collapses into one card instead of
 * flooding the flat grid.
 *
 * A single left-to-right pass over the gallery's newest-first item stream, with
 * two grouping rules, in priority order:
 *
 *   1. Same conversation. Items still linked to a conversation
 *      (`conversationId != null`) are bucketed by that id *globally* — one card
 *      per conversation, regardless of where its media falls in the stream.
 *      Conversation media is NOT contiguous in time: generating in chat A, then
 *      B, then back in A yields A, B, A, so a consecutive-run approach would
 *      emit two "A" groups (and two `{#each}` entries keyed alike → crash).
 *      Bucketing keeps a conversation a single, complete stack.
 *   2. Same-prompt adjacency. The common case is media whose conversation was
 *      deleted (`conversationId == null`); a multi-model batch shares one exact
 *      prompt and lands back-to-back, so *consecutive* orphans with an identical
 *      grouping prompt group together. The grouping prompt is the user's
 *      ORIGINAL prompt (`originalPrompt`) when prompt enhancement rewrote it —
 *      each fan-out branch gets a model-specific enhanced `promptFull`, but they
 *      share the one `originalPrompt`, so grouping on the raw `promptFull` would
 *      stop a fan-out from stacking. Non-enhanced rows fall back to `promptFull`
 *      (which IS the user's prompt). A time-gap guard (`ORPHAN_GAP_MS`) keeps a
 *      much-later re-generation of the same prompt from merging in, and any
 *      conversation item between two orphans breaks the run.
 *
 * Anything matching neither rule (and any group of length 1) renders as a normal
 * solo tile, so the top level is a faithful, true-order mix of stacks and
 * singletons — each group sits at the position of its newest member. Because it
 * operates purely on the loaded `items` array, a trailing group fills in live as
 * more pages paginate in; items are only ever appended, never re-merged.
 */

/** Same-prompt orphan runs break once consecutive items are more than this far
 *  apart in time — a fan-out completes within seconds/minutes, so a re-gen of
 *  an old prompt "much later" stays a separate stack. */
export const ORPHAN_GAP_MS = 60 * 60 * 1000; // 1 hour

export interface GalleryGroup {
	/** Stable identity for drill-in / keyed rendering. Conversation groups use
	 *  the conversation id (one bucket per conversation); prompt/orphan runs use
	 *  `p:<leader item id>`. Unique across groups either way. */
	key: string;
	kind: 'conversation' | 'prompt' | 'solo';
	conversationId: string | null;
	/** Conversation title for `conversation` groups; null otherwise. */
	title: string | null;
	/** Members, newest-first (same order as the input stream). */
	items: MediaListItem[];
}

type Run = GalleryGroup & { kind: 'conversation' | 'prompt' };

/**
 * The `key`/identity of a prompt (orphan) run, anchored to its leader (newest)
 * member's id. Exported so the gallery can re-anchor a drilled-in stack when
 * the leader is the item being deleted (see deleteOne / deleteSelected).
 */
export function promptRunKey(leaderId: string): string {
	return `p:${leaderId}`;
}

/** The prompt an orphan run groups on: the user's original (pre-enhancement)
 *  prompt when present, else the (verbatim) full prompt. Keeps a fan-out's
 *  branches — which share one `originalPrompt` but each carry a model-specific
 *  enhanced `promptFull` — in a single stack, while non-enhanced rows
 *  (originalPrompt = null) still group on their `promptFull`. */
function groupingPrompt(item: MediaListItem): string | null {
	return item.originalPrompt ?? item.promptFull;
}

/** Can `item` extend the open orphan (prompt) run? Identical non-empty grouping
 *  prompt, and the previous (newer) member within the time-gap window. */
function canJoinPromptRun(run: Run, item: MediaListItem): boolean {
	const prompt = groupingPrompt(item);
	const leader = run.items[0];
	if (!prompt || !leader || groupingPrompt(leader) !== prompt) return false;
	const prev = run.items[run.items.length - 1];
	return prev.createdAt - item.createdAt <= ORPHAN_GAP_MS;
}

/**
 * Collapse a newest-first gallery item stream into stacks + solos. Pure; safe
 * to call on the accumulated `items` array on every change.
 */
export function groupGalleryItems(items: MediaListItem[]): GalleryGroup[] {
	const groups: Run[] = [];
	// Conversation buckets are global (one per id), so they're addressed by a
	// map rather than only the tail of `groups`.
	const convGroups = new Map<string, Run>();
	// The orphan run the next orphan item could extend — only the one whose
	// last member was the immediately-preceding stream item. Any conversation
	// item resets it, breaking adjacency.
	let openOrphanRun: Run | null = null;

	for (const item of items) {
		if (item.conversationId != null) {
			const existing = convGroups.get(item.conversationId);
			if (existing) {
				existing.items.push(item);
			} else {
				const run: Run = {
					key: item.conversationId,
					kind: 'conversation',
					conversationId: item.conversationId,
					title: item.conversationTitle,
					items: [item],
				};
				convGroups.set(item.conversationId, run);
				groups.push(run);
			}
			openOrphanRun = null;
			continue;
		}
		// Orphan item: extend the open same-prompt run or start a new one.
		if (openOrphanRun && canJoinPromptRun(openOrphanRun, item)) {
			openOrphanRun.items.push(item);
		} else {
			openOrphanRun = {
				key: promptRunKey(item.id),
				kind: 'prompt',
				conversationId: null,
				title: null,
				items: [item],
			};
			groups.push(openOrphanRun);
		}
	}
	// A group of one isn't a stack — demote to a solo tile. Keys stay unique:
	// conversation buckets are one-per-id; prompt runs key off their leader id.
	return groups.map((g): GalleryGroup => (g.items.length === 1 ? { ...g, kind: 'solo' } : g));
}
