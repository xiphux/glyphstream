/**
 * Client-side cache of the user's prompt-snippet library.
 *
 * Deliberately NOT loaded through the `(app)` layout the way `enabledSkills`
 * is. A realistic library is ~100 style paragraphs — roughly 60 KB raw — and
 * riding that on every page load would spend a meaningful slice of the
 * ~250 KB chat-route budget on a feature many sessions never touch. Instead
 * the composer calls `ensureSnippetsLoaded()` the first time the trigger char
 * is typed, and the result is cached for the session.
 *
 * A user with NO snippets caches the empty result too, so they pay exactly one
 * request ever rather than one per keystroke.
 *
 * Because the settings page and the composer share this module inside one
 * client session, mutations there just call `invalidateSnippets()` — no
 * `depends()`/`invalidate()` load-function wiring is needed.
 */

import type { PromptSnippet } from '$lib/types/api';

let snippets = $state<PromptSnippet[]>([]);
let loaded = $state(false);
let inflight: Promise<void> | null = null;

/** The cached library. Empty until `ensureSnippetsLoaded()` resolves. */
export function snippetList(): PromptSnippet[] {
	return snippets;
}

/** True once a fetch has completed (successfully or not) — lets the menu tell
 *  "no snippets" apart from "not fetched yet". */
export function snippetsLoaded(): boolean {
	return loaded;
}

/**
 * Fetch the library once per session. Idempotent and safe to call on every
 * trigger keypress: concurrent callers share the in-flight promise, and a
 * completed load short-circuits.
 *
 * A failure leaves `loaded` false so a later keypress retries — the menu
 * simply shows nothing in the meantime rather than surfacing an error, since
 * this fires on a keystroke the user may not have meant as a command.
 */
export function ensureSnippetsLoaded(): Promise<void> {
	if (loaded) return Promise.resolve();
	if (inflight) return inflight;
	inflight = (async () => {
		try {
			const res = await fetch('/api/user/prompt-snippets');
			if (!res.ok) return;
			const body = (await res.json()) as { promptSnippets?: PromptSnippet[] };
			snippets = body.promptSnippets ?? [];
			loaded = true;
		} catch {
			/* offline or aborted — retried on the next trigger */
		} finally {
			inflight = null;
		}
	})();
	return inflight;
}

/** Drop the cache after a settings-page mutation so the composer picks up the
 *  change without a reload. */
export function invalidateSnippets(): void {
	snippets = [];
	loaded = false;
	inflight = null;
}

/** Bump a snippet's usage counter. Fire-and-forget: ordering is a nicety, and
 *  a lost count must never interrupt insertion. Updates the local copy so the
 *  menu reorders immediately rather than waiting for the next fetch. */
export function recordSnippetUse(id: string): void {
	const local = snippets.find((s) => s.id === id);
	if (local) local.usageCount += 1;
	void fetch(`/api/user/prompt-snippets/${encodeURIComponent(id)}/use`, { method: 'POST' }).catch(
		() => {},
	);
}
