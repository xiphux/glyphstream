/**
 * Ceilings on user-supplied free text, set far above anything typed or pasted
 * in normal use. They exist to stop the unreasonable case: the request body
 * limit is 25 MB, and some of these fields are re-sent upstream on every turn
 * (a 20 MB custom instruction would be rent on every message) or tokenised by
 * the context readout.
 */

/** One chat message. Larger than any model's context window holds. */
export const MAX_MESSAGE_CHARS = 2_000_000;
/** A system prompt, custom instructions or "about you" (re-sent every turn). */
export const MAX_PROMPT_CHARS = 200_000;
/** A description shown in a list. */
export const MAX_DESCRIPTION_CHARS = 10_000;
/** A name, an id, a tool name. */
export const MAX_NAME_CHARS = 1_000;
/** A saved list: favourite models, model sets, trusted tools. */
export const MAX_LIST_ITEMS = 1_000;
/** An uploaded file's name, as stored. Longer names are cut, not refused. */
export const MAX_FILENAME_CHARS = 255;
