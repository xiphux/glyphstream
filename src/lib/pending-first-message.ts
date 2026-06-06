/**
 * Hand-off of the first message from the new-chat page to the chat page.
 *
 * The new-chat page creates the conversation, stashes the user's typed
 * message + attachments under a per-conversation sessionStorage key, and
 * navigates; the chat page reads it back and fires the real send inside
 * the chat route's own lifecycle.
 *
 * The key is built here — not inlined at the write and read sites — so a
 * typo can't silently desync the two halves of the handoff.
 */

import type { FanoutModel } from './fanout';

export interface PendingFirstMessage {
	text: string;
	attachedMediaIds: string[];
	/** When present, the first message fans out to these models instead of a
	 *  single send — set by the new-chat page when the picker was in compare
	 *  mode. The chat page routes to its fan-out flow on pickup. */
	fanoutModels?: FanoutModel[];
}

/** Per-conversation sessionStorage key for a pending first message. */
export function pendingFirstMessageKey(conversationId: string): string {
	return `glyphstream:pendingFirstMessage:${conversationId}`;
}
