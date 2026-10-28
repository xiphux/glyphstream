/**
 * The durable error row a failed generation leaves behind: an assistant
 * message whose one part is `{ type: 'error', message }`, placed where the
 * reply would have gone.
 *
 * It is what lets a failure outlive the request. The relay's `finally` clears
 * the in-flight entry, so without a row a fan-out branch recovered after the
 * client disconnected (iOS suspending the PWA) would vanish from its grid, and a
 * single send would show nothing on reload. Written by the chat relay, the media
 * relay, and the durable generation jobs; each decides what a failure to write
 * it means, so this throws whatever `appendMessage` throws.
 *
 * A user's Stop never gets one: the callers check for that before calling.
 */
import { appendMessage } from '../db/queries/messages';

type AppendInput = Parameters<typeof appendMessage>[0];

export interface ErrorSiblingInput extends Pick<
	AppendInput,
	'conversationId' | 'modelUsed' | 'genMs' | 'fanoutIndex' | 'inTransaction'
> {
	/** The message the reply answers. */
	parentMessageId: string;
	/** The failure as the user sees it: the same text as the live `error` frame. */
	message: string;
	/** A fan-out branch stays a pinned sibling; a single send advances the leaf. */
	advanceActiveLeaf: boolean;
	/**
	 * Split-attachments provenance: the input image this branch was editing.
	 * Omitted for chat, where the part carries no such key; null for text-to-media.
	 */
	sourceMediaId?: string | null;
}

/** Append the error row. Returns its id. */
export function appendErrorSibling(input: ErrorSiblingInput): string {
	const { message, sourceMediaId, ...rest } = input;
	return appendMessage({
		...rest,
		role: 'assistant',
		parts: [{ type: 'error', message, ...(sourceMediaId !== undefined ? { sourceMediaId } : {}) }],
	}).id;
}
