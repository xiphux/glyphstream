/**
 * The prompt that asks a conversation's model to describe an image of itself.
 *
 * Step one of avatar generation, and deliberately a NORMAL user turn rather
 * than an out-of-band call. Three things fall out of that choice:
 *
 *  - The conversation's own model answers, which is the point — it's the one
 *    that invented the persona, and it already holds the branch as context. No
 *    separate model slot, no re-feeding the transcript to something smaller.
 *  - The description lands in the transcript, so it stays in context as
 *    continuity for the rest of the roleplay (a model that has committed to
 *    "salt-cracked hands" tends to keep them).
 *  - It's editable before sending, and retryable after, using the message
 *    controls that already exist.
 *
 * Wording notes, since this text is the whole feature at this step:
 *  - It names the roleplay case first but doesn't assume it — an avatar for a
 *    conversation about Postgres should be a fitting subject, not a person.
 *  - It asks for concrete categories, because a model asked only to "describe
 *    yourself" reliably answers in temperament rather than pixels, and a
 *    generator can't draw "wry and world-weary".
 *  - It asks for the description inside `<description>` tags. Roleplay-tuned
 *    models often stay in character first and answer second — a paragraph of
 *    prose, THEN the description — and no amount of "reply with only…" reliably
 *    stops that. Asking for a delimiter doesn't have to stop it: whatever
 *    surrounds the tags can simply be dropped. Same trick the prompt enhancer
 *    uses (`<prompt>`) and `activate_skill` (`<skill_content>`).
 *
 * Not a template with slots: the model already knows which persona it's
 * playing, and interpolating a name here would only misfire on the
 * non-roleplay case this is meant to cover.
 */
export const AVATAR_DESCRIPTION_PROMPT =
	"Describe a single image to use as this conversation's avatar. " +
	"If you're playing a character, describe how that character looks; " +
	"otherwise pick a subject that fits what we've been discussing. " +
	'Be concrete and visual — features, colors, materials, setting, lighting. ' +
	'Put the description, and nothing else, inside <description></description> ' +
	'tags: one paragraph, fed straight to an image generator, no dialogue.';

/** Opening/closing delimiter the prompt above asks for. Tolerates whitespace
 *  and any casing, since models are inconsistent about both. */
const DESCRIPTION_OPEN = /<\s*description\s*>/gi;
const DESCRIPTION_CLOSE = /<\s*\/\s*description\s*>/i;

/**
 * Pull the image prompt out of a reply.
 *
 * Returns the contents of the LAST `<description>` block, or — when the model
 * ignored the tags entirely — the whole text, so an older conversation (or a
 * model that won't cooperate) still produces something to draw. The caller
 * shows the result for editing before spending a generation, which is what
 * makes the fallback tolerable rather than a silent wrong answer.
 *
 * LAST rather than first because the failure this exists for is prose THEN
 * description; when there's only one block the two agree anyway.
 *
 * An unclosed opening tag takes everything after it: a reply cut off by a token
 * limit is exactly when the tail is the description, and returning nothing
 * there would be the least useful possible answer.
 */
export function extractAvatarPrompt(text: string): string {
	const opens = [...text.matchAll(DESCRIPTION_OPEN)];
	if (opens.length === 0) return text.trim();

	const last = opens[opens.length - 1];
	const after = text.slice(last.index + last[0].length);
	const close = DESCRIPTION_CLOSE.exec(after);
	const body = (close ? after.slice(0, close.index) : after).trim();

	// A tag pair with nothing usable in it is worse than no tags at all — fall
	// back rather than hand the image model an empty prompt.
	return body || text.trim();
}
