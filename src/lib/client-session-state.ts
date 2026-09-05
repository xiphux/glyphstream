/**
 * Sign-out cleanup for device-local client state.
 *
 * Everything persisted in localStorage under the `glyphstream:` prefix
 * (composer drafts and the sidebar-collapsed flag, today) is session-scoped:
 * useful within a session, but it must not outlive sign-out or it would leak to
 * the next person who signs in on a shared browser. The login page — the
 * chokepoint every explicit logout and every expired/revoked session lands on —
 * calls this to wipe it.
 *
 * Policy consequence: any new `glyphstream:`-prefixed localStorage key is wiped
 * on sign-out by default. State that should genuinely persist across accounts
 * on a device (a true device preference) must live outside this prefix.
 *
 * Beyond localStorage it also drops the pending-notification-tap record
 * (`$lib/sw/pending-navigation.ts`), which lives in Cache Storage. Same
 * argument, different store: it names one user's conversation, Cache Storage is
 * scoped to the origin rather than the session, and an unspent record would
 * otherwise be claimable by whoever signs in next on a shared browser.
 *
 * The `glyphstream:`-prefixed sessionStorage keys (pending-first-message,
 * gallery-launch) are transient, consume-and-delete handoffs that don't outlive
 * the browsing session, so they need no wipe here.
 */

import { browser } from '$app/environment';
import { forgetPendingNavigation } from '$lib/sw/pending-navigation';

const PREFIX = 'glyphstream:';

/** Remove all `glyphstream:`-prefixed localStorage keys. Best-effort. */
export function clearSessionScopedClientState(): void {
	if (!browser) return;
	try {
		// Collect first: removeItem() during iteration shifts the index.
		const keys: string[] = [];
		for (let i = 0; i < localStorage.length; i++) {
			const k = localStorage.key(i);
			if (k?.startsWith(PREFIX)) keys.push(k);
		}
		for (const k of keys) localStorage.removeItem(k);
	} catch {
		/* storage disabled — nothing to clear */
	}
	// Fire-and-forget: an async teardown must not hold up the sign-out render,
	// and the record expires on its own if this never lands.
	if (typeof caches !== 'undefined') void forgetPendingNavigation(caches);
}
