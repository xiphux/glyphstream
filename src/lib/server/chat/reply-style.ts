/**
 * The system-prompt block a reply style adds at send time, and the photo and
 * check-in instructions that ride with it when the conversation allows them.
 *
 * The app owns the character format end to end: `#lib/texting.ts` splits a
 * reply into texts and reads `Name: ` speaker prefixes, `#lib/scenes.ts` reads
 * the scene markers, and this tells the model to write exactly that. A
 * preset's own prompt then only has to describe the character(s). Added per
 * request rather than snapshotted, so improving the wording reaches existing
 * chats — and a conversation's style and starting scene never change after
 * creation, so the block is stable across its turns. The scene changes in the
 * thread, by marker, never here: describing only the current scene would move
 * the prefix at every meeting and parting.
 *
 * Re-sent on every turn: keep it short.
 */
import type { ReplyStyle, Scene } from '#lib/types/api.js';
import { getCheckInsConfig } from '../endpoints/config';

const CHARACTER_INSTRUCTIONS =
	'This conversation moves between texting and being together in person. ' +
	'While texting, write each text as its own short paragraph, separated by a blank line; ' +
	'each paragraph appears as a separate message bubble. ' +
	'In person, write the scene as it happens, with actions in *asterisks*. ' +
	'When you meet up, or part and go back to texting, write [in person] or [texting] as a paragraph of its own ' +
	"where it happens — only when it would really happen, for this character and this situation. The user's " +
	'messages may change scenes the same way. ' +
	"Don't put your name in front of what you say. " +
	'To speak as someone else, begin the paragraph with their name and a colon ("Name: "). ' +
	'A paragraph with no name is from whoever spoke before it, or from you if it comes first. ' +
	'Never otherwise begin a paragraph with a word followed by a colon.';

const STARTS: Record<Scene, string> = {
	texting: 'The conversation starts over text.',
	in_person: 'The conversation starts in person.',
};

/** The character block, for a chat that opens in `startingScene`. */
export function characterInstructions(startingScene: Scene): string {
	return `${CHARACTER_INSTRUCTIONS} ${STARTS[startingScene]}`;
}

/**
 * The photo marker `#lib/texting.ts` reads, per style — on only for a
 * conversation whose preset allows photos. The image model that develops it
 * sees only this description, hence "completely"; the ratio is picked up by the
 * draw dialog's aspect-ratio detection. A developed photo shows where its
 * marker is, so it can go anywhere in the reply, but it must be a paragraph of
 * its own — that's the unit the marker is read from. A character's covers both
 * scenes: a photo texted over, or the moment as it looks in person.
 */
export const PHOTO_INSTRUCTIONS: Record<ReplyStyle, string> = {
	character:
		'To show a photo, when it fits the moment — one you send while texting, or the scene as they see it ' +
		'in person — write it as a paragraph of its own: [photo: what it shows]. ' +
		"The camera can't see this chat, so describe the picture completely, including how anyone in it looks, " +
		'and give its aspect ratio: 3:4, 2:3 or 9:16 upright; 4:3, 3:2 or 16:9 sideways.',
	standard:
		'To share a photo, when it fits, write it as a paragraph of its own: [photo: what it shows]. ' +
		"The camera can't see this chat, so describe the picture completely, including how anyone in it looks, " +
		'and give its aspect ratio: 3:4, 2:3 or 9:16 upright; 4:3, 3:2 or 16:9 sideways.',
};

/**
 * The check-in marker `#lib/check-ins.ts` reads, per style — on only for a
 * conversation whose preset allows check-ins. It must be a paragraph of its
 * own: that's the unit both the parser and the bubbles split on, so "a line of
 * its own" (one newline) would leave it unread and on show. The "If you tell
 * them you'll …" condition is what keeps every goodbye from setting one. The reminder, when it comes, says
 * how to pass on it; that wording lives there, not here, because this is rent.
 */
export const CHECK_IN_INSTRUCTIONS: Record<ReplyStyle, string> = {
	character:
		"If you tell them you'll text later, end your reply with [later 2h: what you mean to text about] " +
		"(any delay up to 24h). If they haven't replied by then, you'll be reminded so you can text them.",
	standard:
		"If you tell the user you'll get back to them later, end your reply with [later 2h: what you mean to say] " +
		"as its own paragraph (any delay up to 24h). If they haven't replied by then, you'll be reminded so you " +
		'can reach out.',
};

export function replyStyleInstructions(
	style: ReplyStyle,
	checkIns = false,
	photos = false,
	startingScene: Scene = 'texting',
): string | null {
	const parts = [
		style === 'character' ? characterInstructions(startingScene) : null,
		photos ? PHOTO_INSTRUCTIONS[style] : null,
		checkIns && getCheckInsConfig().enabled ? CHECK_IN_INSTRUCTIONS[style] : null,
	].filter((p): p is string => p !== null);
	return parts.length > 0 ? parts.join(' ') : null;
}
