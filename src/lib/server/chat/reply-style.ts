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
import { getCheckInsConfig } from '../endpoints/config';

export const TEXTING_INSTRUCTIONS =
	"You're texting. Write each text as its own short paragraph, separated by a blank line; " +
	"each paragraph appears as a separate message bubble. Don't put your name in front of your texts. " +
	'To send a text as someone else in the chat, begin it with their name and a colon ("Name: "). ' +
	'A text with no name is from whoever sent the text before it, or from you if it comes first. ' +
	'Never otherwise begin a text with a word followed by a colon. ' +
	// The photo marker `#lib/texting.ts` reads. The image model that develops it
	// sees only this description, hence "completely"; the ratio is picked up by
	// the draw dialog's aspect-ratio detection. "After your other texts" because
	// that is where a developed photo shows up: it arrives as a message of its
	// own after the reply, so a marker mid-reply would read out of order.
	'To send a photo, when it fits the moment, write it as its own text after your other texts: ' +
	'[photo: what it shows]. ' +
	"The camera can't see this chat, so describe the picture completely, including how anyone in it looks, " +
	'and give its aspect ratio: 3:4, 2:3 or 9:16 upright; 4:3, 3:2 or 16:9 sideways.';

/**
 * The check-in marker `#lib/check-ins.ts` reads. "Only when you've said so" is
 * what keeps every goodbye from setting one. The reminder, when it comes, says
 * how to pass on it; that wording lives there, not here, because this is rent.
 */
export const CHECK_IN_INSTRUCTIONS =
	"If you tell them you'll text later, end your reply with [later 2h: what you mean to text about] " +
	"(any delay up to 24h). If they haven't replied by then, you'll be reminded so you can text them.";

export function replyStyleInstructions(style: ReplyStyle): string | null {
	if (style !== 'texting') return null;
	return getCheckInsConfig().enabled
		? `${TEXTING_INSTRUCTIONS} ${CHECK_IN_INSTRUCTIONS}`
		: TEXTING_INSTRUCTIONS;
}
