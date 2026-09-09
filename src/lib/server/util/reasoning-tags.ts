/**
 * Strip reasoning markup out of a model's `content`.
 *
 * A reasoning-capable model asked for a short single-line answer sometimes puts
 * its thinking in `content` rather than the `reasoning_content` field — or, more
 * often, leaves a lone `</think>` behind when the thinking itself was suppressed
 * (`--reasoning-budget 0`). Measured on the task model this repo shipped with:
 * 4 of 30 conversation titles came back as e.g.
 * `"Brotli vs. Gzip Compression </think>"`, and that string is what the user
 * sees in their sidebar — `sanitizeModelLabel` strips quotes, labels and
 * trailing punctuation, but had nothing to say about a stray tag.
 *
 * Deterministic rather than prompted, for the same reason the enhancer counts
 * booru subjects in code: a small model cannot be reliably instructed out of
 * emitting these, and the failure is silent and user-visible.
 *
 * Three shapes, in the order they're handled:
 *
 *   1. A COMPLETE block is dropped whole, contents included — that text is
 *      reasoning, not answer.
 *   2. A widowed CLOSING tag with real text after it — text carrying a letter
 *      or digit, not just a stray quote or full stop — means the answer is what
 *      FOLLOWS it, and everything before was thinking. That shape is what a
 *      chat template which prefills `<think>` into the assistant turn produces
 *      when reasoning isn't suppressed: the opener never appears in `content`
 *      because the template supplied it. Keeping the text before instead would
 *      title the conversation with a truncated reasoning paragraph — a worse
 *      failure than the raw tag, because it doesn't look broken.
 *   3. Any tag still standing is dropped on its own, keeping the text around
 *      it. That covers the measured suppressed-reasoning case (answer, then a
 *      widowed closer with nothing after it).
 *
 * Limits, none of which have a rescue: an unclosed `<think>` followed by
 * thinking and NO answer leaves the thinking (there is no answer in the string
 * to recover — callers already treat an empty result as failure, keeping the
 * fallback title / the user's prompt). And content legitimately *about* this
 * markup loses the word: a conversation titled "How to use <think> tags" comes
 * back as "How to use tags". Titles are user-editable, and silently deleting a
 * word beats surfacing raw markup.
 */

/** Tag names seen in the wild for the same thing. */
const TAG = 'think|thinking|reason|reasoning';
/** An opening tag may carry attributes (`<think type="x">`); a closing tag may
 *  carry stray whitespace (`</think >`). Matching neither leaves the literal
 *  markup in the output, which is the whole failure this module exists for. */
const ATTRS = '(?:\\s[^>]*)?';
/** A properly closed block, contents included. Non-greedy so two sibling blocks
 *  don't merge into one and swallow the answer between them; a NESTED block
 *  therefore closes early and leaks its outer tail. Rule 2 recovers that only
 *  when the answer FOLLOWS the nesting — with the answer first, the outer
 *  reasoning still trails it. Sibling blocks are the common shape; nesting is
 *  the rare one, so the trade goes this way. */
const BLOCK = new RegExp(`<(${TAG})${ATTRS}>[\\s\\S]*?<\\/\\1\\s*>`, 'gi');
/** Closing tags only — used to locate the reasoning/answer boundary. Same ATTRS
 *  tolerance as the others, so a tag this finds is one LOOSE can also strip. */
const CLOSE = new RegExp(`<\\/(?:${TAG})${ATTRS}>`, 'gi');
/** Whatever tag survives the passes above. */
const LOOSE = new RegExp(`<\\/?(?:${TAG})${ATTRS}>`, 'gi');

/** A tail counts as the answer only if it has a letter or digit in it. Merely
 *  "not whitespace" is too weak: this runs BEFORE the quote and trailing-
 *  punctuation strips, so a model that closes its thinking inside its own
 *  quoting ends the string `…</think>"` — and taking that `"` as the answer
 *  yields a one-character title, or a one-character prompt for an image model,
 *  which is worse than the raw tag this module exists to remove. Falling
 *  through instead lets the existing quote-pair strip recover it. */
const HAS_CONTENT = /[\p{L}\p{N}]/u;

/** The text following the LAST widowed closing tag, or null when there is no
 *  such tag or nothing but punctuation/whitespace after it. */
function answerAfterWidowedClose(s: string): string | null {
	// Explicit reset: CLOSE is module-level and `exec` advances lastIndex, so a
	// throw mid-loop would otherwise leave it dirty for the next caller.
	CLOSE.lastIndex = 0;
	let last: RegExpExecArray | null = null;
	for (let m = CLOSE.exec(s); m !== null; m = CLOSE.exec(s)) last = m;
	if (!last) return null;
	const after = s.slice(last.index + last[0].length);
	return HAS_CONTENT.test(after) ? after : null;
}

/**
 * Note what this deliberately does NOT do: collapse whitespace. Only the label
 * sanitizer wants that (its outputs are one line, and it collapses on its own).
 * Enhanced prompts are legitimately multi-line — a JSON prompt, and above all
 * `multimodal-script`, whose three labeled fields are separated by REQUIRED
 * blank lines. Flattening here would silently corrupt every video prompt in that
 * style, and the enhancer's own fenced-block strip needs the newlines too.
 */
export function stripReasoningTags(raw: string): string {
	const withoutBlocks = raw.replace(BLOCK, ' ');
	const answer = answerAfterWidowedClose(withoutBlocks);
	return (answer ?? withoutBlocks).replace(LOOSE, ' ').trim();
}
