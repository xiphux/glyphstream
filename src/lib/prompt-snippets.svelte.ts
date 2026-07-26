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

/**
 * How long to wait before retrying after a failed load.
 *
 * The caller fires on every keystroke AND every caret move inside a `;` token,
 * so without a cooldown one failing endpoint turned a single attempted snippet
 * use into ~20 requests — adding load exactly when the server is already
 * unhealthy, and filling the console with errors while the user is just typing.
 */
const RETRY_AFTER_FAILURE_MS = 30_000;
let nextRetryAt = 0;

/**
 * Bumped by `invalidateSnippets()` so a load that was already in flight can't
 * commit its result afterwards.
 *
 * Nulling `inflight` isn't enough on its own: the running promise keeps its
 * closure and would still assign `snippets` and set `loaded = true` — pinning
 * the cache to the pre-mutation library for the rest of the session, since
 * `loaded` then short-circuits every later call. A superseded failure would
 * likewise re-arm the retry cooldown the invalidation had just cleared.
 */
let generation = 0;

/**
 * Fetch the library once per session. Idempotent and safe to call on every
 * trigger keypress: concurrent callers share the in-flight promise, and a
 * completed load short-circuits.
 *
 * A failure leaves `loaded` false so a later keypress retries, but not before
 * the cooldown above. The menu simply shows nothing in the meantime rather than
 * surfacing an error, since this fires on a keystroke the user may not have
 * meant as a command.
 */
export function ensureSnippetsLoaded(): Promise<void> {
	if (loaded) return Promise.resolve();
	if (inflight) return inflight;
	if (Date.now() < nextRetryAt) return Promise.resolve();
	const gen = generation;
	inflight = (async () => {
		try {
			const res = await fetch('/api/user/prompt-snippets');
			if (gen !== generation) return;
			if (!res.ok) {
				nextRetryAt = Date.now() + RETRY_AFTER_FAILURE_MS;
				return;
			}
			const body = (await res.json()) as { promptSnippets?: PromptSnippet[] };
			if (gen !== generation) return;
			snippets = body.promptSnippets ?? [];
			loaded = true;
			nextRetryAt = 0;
		} catch {
			/* offline or aborted — retried after the cooldown */
			if (gen === generation) nextRetryAt = Date.now() + RETRY_AFTER_FAILURE_MS;
		} finally {
			// Only clear the slot we own. A superseded run must not null a newer
			// load's `inflight`, or the dedupe breaks and requests pile up.
			if (gen === generation) inflight = null;
		}
	})();
	return inflight;
}

/** Drop the cache after a settings-page mutation so the composer picks up the
 *  change without a reload. Clears the failure cooldown too, since this is an
 *  explicit "go look again". */
export function invalidateSnippets(): void {
	generation++;
	snippets = [];
	loaded = false;
	inflight = null;
	nextRetryAt = 0;
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
