/**
 * The system-prompt block a reply style adds at send time.
 *
 * The app owns the texting format end to end: `#lib/texting.ts` splits a reply
 * into bubbles and reads `Name: ` speaker prefixes, and this tells the model to
 * write exactly that. A preset's own prompt then only has to describe the
 * character(s). Added per request rather than snapshotted, so improving the
 * wording reaches existing texting chats — and a conversation's style never
 * changes after creation, so the block is stable across its turns.
 *
 * Re-sent on every turn: keep it short.
 */
import type { ReplyStyle } from '#lib/types/api.js';

export const TEXTING_INSTRUCTIONS =
	"You're texting. Write each text as its own short paragraph, separated by a blank line; " +
	"each paragraph appears as a separate message bubble. Don't put your name in front of your texts. " +
	'To send a text as someone else in the chat, begin it with their name and a colon ("Name: "). ' +
	'A text with no name is from whoever sent the text before it, or from you if it comes first. ' +
	'Never otherwise begin a text with a word followed by a colon.';

export function replyStyleInstructions(style: ReplyStyle): string | null {
	return style === 'texting' ? TEXTING_INSTRUCTIONS : null;
}
