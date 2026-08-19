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
 *  - It names the destination ("fed straight to an image generator") so weaker
 *    models don't wrap the answer in narration.
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
	'Reply with one paragraph of description that will be fed straight to an ' +
	'image generator: no dialogue, no commentary.';
