/**
 * Per-conversation composer draft persistence (localStorage).
 *
 * Keeps what the user has half-typed in the prompt box so an interrupted
 * compose survives a reload. The motivating case is an iOS PWA that the OS
 * freezes in the background and then reloads on return — without this, the
 * in-progress message is silently thrown away. Drafts are device-local and
 * ephemeral, so they live in localStorage, never the server.
 *
 * Keyed per conversation (plus a `new` slot for the new-chat box) so a draft
 * for one chat never bleeds into another. Cleared on submit; entries also
 * carry a timestamp and are dropped on load once older than DRAFT_MAX_AGE_MS
 * so an abandoned (or orphaned, post-conversation-delete) draft can't
 * resurface days later.
 *
 * Drafts are session-scoped so they can't leak to the next person on a shared
 * device: sign-out wipes them along with the rest of the `glyphstream:`
 * localStorage namespace (see clearSessionScopedClientState in
 * client-session-state.ts, called from the login page — the chokepoint every
 * explicit logout and every silent session expiry/revocation lands on).
 */

import { browser } from '$app/environment';

const PREFIX = 'glyphstream:composerDraft:';
/** Drafts older than this are treated as expired and ignored/removed on load. */
const DRAFT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
/** Coalesce keystrokes into at most one write per this many ms of quiet. */
const SAVE_DEBOUNCE_MS = 500;

/** localStorage key for a conversation's draft, or the new-chat box when null. */
function draftKey(conversationId: string | null): string {
	return `${PREFIX}${conversationId ?? 'new'}`;
}

interface StoredDraft {
	text: string;
	savedAt: number;
}

/**
 * Read a saved draft, or '' when there is none / it has expired / storage is
 * unavailable. A malformed or expired entry is removed as a side effect.
 */
export function loadDraft(conversationId: string | null): string {
	if (!browser) return '';
	const key = draftKey(conversationId);
	let raw: string | null;
	try {
		raw = localStorage.getItem(key);
	} catch {
		return '';
	}
	if (!raw) return '';
	try {
		const parsed = JSON.parse(raw) as StoredDraft;
		if (
			!parsed ||
			typeof parsed.text !== 'string' ||
			typeof parsed.savedAt !== 'number' ||
			Date.now() - parsed.savedAt > DRAFT_MAX_AGE_MS
		) {
			clearDraft(conversationId);
			return '';
		}
		return parsed.text;
	} catch {
		clearDraft(conversationId);
		return '';
	}
}

/** Persist a draft. Empty / whitespace-only text removes the key instead. */
export function saveDraft(conversationId: string | null, text: string): void {
	if (!browser) return;
	if (text.trim() === '') {
		clearDraft(conversationId);
		return;
	}
	try {
		localStorage.setItem(
			draftKey(conversationId),
			JSON.stringify({ text, savedAt: Date.now() } satisfies StoredDraft),
		);
	} catch {
		/* quota exceeded / storage disabled — drafts are best-effort */
	}
}

/** Remove a saved draft (on submit, or once it becomes empty). */
export function clearDraft(conversationId: string | null): void {
	if (!browser) return;
	try {
		localStorage.removeItem(draftKey(conversationId));
	} catch {
		/* ignore */
	}
}

/**
 * Debounced draft writer for a live composer.
 *
 * Call `save(conversationId, text)` on every keystroke (cheap); the actual
 * localStorage write coalesces to one per SAVE_DEBOUNCE_MS of quiet. The
 * pending write is force-flushed when the page is hidden (`visibilitychange` →
 * hidden) or torn down (`pagehide` / `dispose`) — the iOS case where the PWA is
 * frozen and may be killed without another tick of script ever running, so a
 * debounce alone would lose the last burst of typing.
 *
 * The pending (id, text) is captured at `save()` time, not read back at flush
 * time. That matters because a single composer component is reused across
 * conversation switches: if a still-pending write belongs to a *different*
 * conversation than the incoming `save()`, it's committed first, so a quick
 * client-side switch (which fires no `pagehide`) can't drop the conversation
 * you just left's draft when the new conversation's keystroke reschedules the
 * shared timer.
 */
export function createDraftWriter() {
	let timer: ReturnType<typeof setTimeout> | undefined;
	let hasPending = false;
	let pendingId: string | null = null;
	let pendingText = '';

	/** Persist the pending write now (if any) and clear the timer. */
	function commit() {
		if (timer !== undefined) {
			clearTimeout(timer);
			timer = undefined;
		}
		if (hasPending) {
			saveDraft(pendingId, pendingText);
			hasPending = false;
		}
	}

	function save(conversationId: string | null, text: string) {
		if (!browser) return;
		// A pending write for a *different* conversation must land before we
		// start debouncing this one — otherwise the reschedule below would strand
		// the previous conversation's draft on a fast switch.
		if (hasPending && pendingId !== conversationId) commit();
		hasPending = true;
		pendingId = conversationId;
		pendingText = text;
		if (timer !== undefined) clearTimeout(timer);
		timer = setTimeout(commit, SAVE_DEBOUNCE_MS);
	}

	/** Drop the pending write without persisting (e.g. after an explicit clear). */
	function cancel() {
		if (timer !== undefined) {
			clearTimeout(timer);
			timer = undefined;
		}
		hasPending = false;
	}

	function onVisibilityChange() {
		if (document.visibilityState === 'hidden') commit();
	}

	if (browser) {
		document.addEventListener('visibilitychange', onVisibilityChange);
		window.addEventListener('pagehide', commit);
	}

	/**
	 * Persist any pending write, then detach listeners. Call on component
	 * teardown — a client-side route change away from the composer fires no
	 * `pagehide`, so this is the only chance to flush an in-progress draft.
	 */
	function dispose() {
		commit();
		if (browser) {
			document.removeEventListener('visibilitychange', onVisibilityChange);
			window.removeEventListener('pagehide', commit);
		}
	}

	return { save, commit, cancel, dispose };
}
