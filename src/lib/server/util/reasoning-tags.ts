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
 * A COMPLETE block is dropped whole, including its contents — that text is
 * reasoning, not answer. An unpaired tag is dropped on its own, keeping the
 * text around it, because that is the shape the suppressed-reasoning case
 * takes (answer plus a widowed closing tag). The one case this cannot rescue
 * is an unclosed `<think>` followed by real thinking and no answer: the tag
 * goes, the thinking stays, and there is no answer in the string to recover.
 * Callers already treat the result as failure when it comes back empty (the
 * title task keeps its fallback; the enhancer keeps the user's prompt).
 */

/** Tag names seen in the wild for the same thing. */
const TAG = 'think|thinking|reason|reasoning';
/** A properly closed block, contents included. Non-greedy so two blocks don't
 *  merge into one and swallow the answer between them. */
const BLOCK = new RegExp(`<(${TAG})\\s*>[\\s\\S]*?<\\/\\1\\s*>`, 'gi');
/** Whatever tag survives the block pass — the widowed-`</think>` case. */
const LOOSE = new RegExp(`<\\/?(?:${TAG})\\s*>`, 'gi');

/**
 * Note what this deliberately does NOT do: collapse whitespace. Only the label
 * sanitizer wants that (its outputs are one line, and it collapses on its own).
 * Enhanced prompts are legitimately multi-line — a JSON prompt, and above all
 * `multimodal-script`, whose three labeled fields are separated by REQUIRED
 * blank lines. Flattening here would silently corrupt every video prompt in that
 * style, and the enhancer's own fenced-block strip needs the newlines too.
 */
export function stripReasoningTags(raw: string): string {
	return raw.replace(BLOCK, ' ').replace(LOOSE, ' ').trim();
}
