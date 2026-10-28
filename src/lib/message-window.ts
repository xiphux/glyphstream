/**
 * The chat page holds a window of the active branch — the newest messages,
 * plus whatever older ones the user has scrolled up to load. A refresh of the
 * page (a tool turn, an approval, a branch switch, a compaction…) brings back
 * only the newest window again, and replacing the list with it would throw away
 * every older message the user had loaded and drop them back at the bottom of a
 * shorter thread.
 */
import type { ChatMessage } from '#lib/types/api.js';

/**
 * Fold a refreshed newest window into the list the page holds.
 *
 * When the fresh window's first message is one the page already has, the
 * messages before it are that message's ancestors — the branch is a parent
 * chain, so they are the same rows — and are kept. Their texting photos are
 * the one part of them that can still change, so the page patches those in
 * place when they do (see the chat page's `applyPhotoState`) rather than
 * relying on this. Otherwise the branch
 * changed above the window (a switch or an edit far up the thread) and the
 * fresh window replaces the list. `keptEarlier` says which happened, so the
 * caller knows whose "has earlier" flag still applies.
 */
export function mergeRefreshedWindow(
	current: readonly ChatMessage[],
	fresh: ChatMessage[],
): { messages: ChatMessage[]; keptEarlier: boolean } {
	if (fresh.length === 0) return { messages: fresh, keptEarlier: false };
	const at = current.findIndex((m) => m.id === fresh[0].id);
	if (at <= 0) return { messages: fresh, keptEarlier: false };
	return { messages: [...current.slice(0, at), ...fresh], keptEarlier: true };
}
