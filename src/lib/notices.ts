/**
 * One-shot notices passed across a server-side redirect via `?notice=`.
 *
 * A load function that can't render its page redirects somewhere usable and
 * names the reason; the destination page turns it into a toast and strips the
 * param from the URL so a reload doesn't replay it.
 *
 * The only destination wired up today is `(app)/+page.svelte` (new chat) — it
 * is where the one existing redirect lands. Redirecting to some other route
 * with a `?notice=` means teaching that page to consume it too, or lifting the
 * consumer into `(app)/+layout.svelte`.
 */

/** A conversation was requested that doesn't exist (or isn't the user's). */
export const CONVERSATION_MISSING_NOTICE = 'conversation-missing';

const NOTICE_MESSAGES: Record<string, string> = {
	[CONVERSATION_MISSING_NOTICE]: 'That conversation no longer exists.',
};

/** Message for a `?notice=` value, or null when the value is unrecognized. */
export function noticeMessage(notice: string | null): string | null {
	if (!notice) return null;
	// hasOwn, not a bare index: `notice` comes off the URL, and `?notice=
	// constructor` would otherwise resolve up the prototype chain to a
	// non-string that sails past the caller's null check.
	if (!Object.hasOwn(NOTICE_MESSAGES, notice)) return null;
	return NOTICE_MESSAGES[notice];
}
