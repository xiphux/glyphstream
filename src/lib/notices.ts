/**
 * One-shot notices passed across a server-side redirect via `?notice=`.
 *
 * A load function that can't render its page redirects somewhere usable and
 * names the reason; the destination page turns it into a toast and strips the
 * param from the URL so a reload doesn't replay it.
 */

/** A conversation was requested that doesn't exist (or isn't the user's). */
export const CONVERSATION_MISSING_NOTICE = 'conversation-missing';

const NOTICE_MESSAGES: Record<string, string> = {
	[CONVERSATION_MISSING_NOTICE]: 'That conversation no longer exists.',
};

/** Message for a `?notice=` value, or null when the value is unrecognized. */
export function noticeMessage(notice: string | null): string | null {
	if (!notice) return null;
	return NOTICE_MESSAGES[notice] ?? null;
}
