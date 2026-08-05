/**
 * Shared readers over a message's `parts[]`.
 *
 * `partsToText` had two independent implementations — one in
 * `server/endpoints/serialize-upstream.ts` (what gets sent upstream) and one
 * inline in the chat page (what Copy puts on the clipboard). Functionally
 * identical, but nothing tied them together, so "the text of this message"
 * could quietly come to mean two different things on the two paths. It's a
 * small contract, and exactly the kind that should have one definition.
 *
 * Client-safe on purpose: the server serializer and the browser both need it,
 * and `MessagePart` already lives in `$lib/types/api`.
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
