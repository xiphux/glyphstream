/**
 * Shared readers over a message's `parts[]`.
 *
 * `partsToText` is the one definition of "the text of this message", shared
 * by `server/endpoints/serialize-upstream.ts` (what gets sent upstream) and
 * the chat page (what Copy puts on the clipboard), so the two paths can't
 * quietly come to mean different things.
 *
 * Client-safe on purpose: the server serializer and the browser both need it,
 * and `MessagePart` already lives in `#lib/types/api.js`.
 */

import type { MessagePart } from './types/api';

/** Concatenate just the text parts of a message — the cheap path when no
 *  images or tool calls are involved. Non-text parts contribute nothing. */
export function partsToText(parts: MessagePart[]): string {
	return parts
		.filter((p): p is Extract<MessagePart, { type: 'text' }> => p.type === 'text')
		.map((p) => p.text)
		.join('');
}

/** Whether a message has any text worth offering a Copy action for. Media-only
 *  messages (a bare generated image) have nothing to put on the clipboard. */
export function hasCopyableText(parts: MessagePart[]): boolean {
	return partsToText(parts).trim().length > 0;
}
