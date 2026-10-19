/**
 * Catch a reaction the model typed instead of calling the tool.
 *
 * A model that means to react often writes the emoji as the first line of its
 * reply — `❤️\n\nOh, Chris…` — rather than calling `react_to_message`. That
 * renders as prose and no badge. Measured against a warm roleplay persona on
 * Gemma4-26B, it was most of the reactions the model attempted until the hint
 * told it not to, and still turns up after (see REACTIONS_HINT in react.ts).
 *
 * This stage turns that shape back into what the model meant: it holds the
 * reply's opening text until it can tell, and when it is a lone emoji on its own
 * line followed by a blank line and more text, it emits a synthetic
 * `react_to_message` call in place of the emoji and passes the rest through.
 * From there nothing is special — the relay runs the tool (which validates the
 * emoji again), persists its result, lands the badge, and short-circuits the
 * turn exactly as for a real call. The history then shows the model calling the
 * tool, which is the in-context example it was missing.
 *
 * Deliberately narrow, because it rewrites what the model wrote:
 *
 * - **Own line, then a blank line.** `🎉 That's fantastic news!` is prose style
 *   and stays. Every typed reaction measured had the blank line; a single
 *   newline is as likely to be a heading.
 * - **Text must follow.** A reply that is only an emoji stays a reply — taking
 *   it would leave an empty message.
 * - **Not a structural symbol.** `⚠️` / `✅` / arrows lead technical replies as
 *   markers, not reactions. The tool description already says "not symbols".
 *
 * It is a wrapper around the normalizer rather than a step in the relay because
 * the relay parses every upstream stream twice — once for the client, once for
 * the recorder that persists the row — and both must see the same rewrite. Each
 * wraps its own normalizer with the same `toolCallId`.
 *
 * A caught reply reads as a tool turn whatever finish reason the upstream gave
 * (`stop`, a vendor's own `eos_token`, or none at all), except `length` and
 * `content_filter`, which say the reply didn't complete and are kept. On those,
 * and on a Stop or stream error after the catch, the relay drops the synthetic
 * call as never-executed and the emoji is lost with it — the text has already
 * streamed without it. A reply cut off there has bigger problems.
 */

import { randomBytes } from 'node:crypto';
import { REACTION_TOOL_NAME, graphemes, isReactionTool, validateEmoji } from '#lib/chat-render.js';
import type { NormalizedDelta, NormalizedResult, StreamNormalizer } from './normalizers';

/** Finish reasons that say the reply didn't complete, kept as they are. */
const INCOMPLETE_FINISH = new Set(['length', 'content_filter']);

/** Upstream tool-call indexes count up from 0, so this can't collide. */
const SYNTHETIC_INDEX = -1;

/** Past this much held text without a verdict, it isn't the shape — release.
 *  A ZWJ emoji plus its blank line is well under it. */
const MAX_HOLD_CHARS = 64;

/** Leading symbols that mark structure in a reply rather than react to the
 *  user: warnings, status, list markers, arrows. Compared on the first code
 *  point, so a variation selector doesn't matter. */
const STRUCTURAL = new Set(
	[
		0x26a0, 0x2705, 0x2714, 0x2611, 0x274c, 0x2716, 0x274e, 0x2757, 0x2755, 0x2753, 0x2754, 0x203c,
		0x2049, 0x2139, 0x27a1, 0x2b05, 0x2b06, 0x2b07, 0x21a9, 0x21aa, 0x25b6, 0x25c0, 0x26d4, 0x1f6ab,
		0x1f6d1, 0x1f6a8, 0x1f4a1, 0x1f4cc, 0x1f4dd, 0x1f539, 0x1f538, 0x1f534, 0x1f535, 0x1f7e0,
		0x1f7e1, 0x1f7e2,
	].map((cp) => String.fromCodePoint(cp)),
);

const PICTOGRAPHIC = /\p{Extended_Pictographic}/u;
/** The emoji's line break and the blank line after it. */
const BLANK_LINE_AFTER = /^[ \t]*\r?\n[ \t]*\r?\n\s*/;
/** What may still grow into BLANK_LINE_AFTER. */
const MAYBE_BLANK_LINE = /^[ \t]*(\r?\n[ \t]*)?\r?$/;

function firstTwoGraphemes(s: string): string[] {
	const out: string[] = [];
	for (const { segment } of graphemes().segment(s)) {
		out.push(segment);
		if (out.length === 2) break;
	}
	return out;
}

type Verdict =
	{ kind: 'hold' } | { kind: 'release' } | { kind: 'react'; emoji: string; rest: string };

/** Decide what the held opening text is. `hold` means it could still go either
 *  way; the caller turns a `hold` at end-of-text into `release`. */
export function classifyLeadingText(held: string): Verdict {
	const v = classify(held);
	return v.kind === 'hold' && held.length > MAX_HOLD_CHARS ? { kind: 'release' } : v;
}

function classify(held: string): Verdict {
	const body = held.trimStart();
	if (body === '') return { kind: 'hold' };
	const [first, second] = firstTwoGraphemes(body);
	// Plain text: decided on the first character, so ordinary replies are held
	// for one delta at most.
	if (!PICTOGRAPHIC.test(first)) return { kind: 'release' };
	// The grapheme can still grow (a variation selector, skin tone or ZWJ arriving
	// in the next token) until something follows it.
	if (second === undefined) return { kind: 'hold' };
	const emoji = validateEmoji(first);
	if (!emoji || STRUCTURAL.has(String.fromCodePoint(first.codePointAt(0)!))) {
		return { kind: 'release' };
	}
	const after = body.slice(first.length);
	const blank = BLANK_LINE_AFTER.exec(after);
	if (!blank) return MAYBE_BLANK_LINE.test(after) ? { kind: 'hold' } : { kind: 'release' };
	const rest = after.slice(blank[0].length);
	return rest === '' ? { kind: 'hold' } : { kind: 'react', emoji, rest };
}

const ID_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

/**
 * An id for the synthetic call. It is persisted and re-sent upstream on every
 * later turn, and until now every id came from an upstream, so it was always one
 * that upstream accepts. Nine alphanumerics is the strictest format in use —
 * Mistral's tokenizer (vLLM with `mistral_common`) rejects anything else, which
 * would 400 every later turn of the conversation — and every other upstream
 * takes it.
 */
export function syntheticReactionId(): string {
	return Array.from(randomBytes(9), (b) => ID_ALPHABET[b % ID_ALPHABET.length]).join('');
}

/**
 * Wrap `inner` so a typed leading reaction becomes a `react_to_message` call
 * with id `toolCallId`. Only wrap when the model was offered the tool this
 * iteration and hasn't already reacted this turn — the stage itself doesn't know.
 */
export function catchLeadingReaction(
	inner: StreamNormalizer,
	toolCallId: string,
): StreamNormalizer {
	let state: 'holding' | 'passthrough' | 'reacted' = 'holding';
	let held = '';
	// A real reaction call arriving after we synthesized one would be a second
	// reaction to the same message; ours stands in for it.
	const suppressed = new Set<number>();
	let sawFinish = false;

	function transform(r: NormalizedResult, final: boolean): NormalizedResult {
		const out: NormalizedDelta[] = [];
		const release = () => {
			if (held) out.push({ type: 'text', text: held });
			held = '';
			state = 'passthrough';
		};
		for (const d of r.deltas) {
			if (state === 'holding') {
				if (d.type === 'text') {
					held += d.text;
					const v = classifyLeadingText(held);
					if (v.kind === 'release') release();
					else if (v.kind === 'react') {
						out.push(
							{
								type: 'tool_call_start',
								toolCallId,
								toolName: REACTION_TOOL_NAME,
								index: SYNTHETIC_INDEX,
							},
							{
								type: 'tool_call_args_delta',
								toolCallId,
								index: SYNTHETIC_INDEX,
								argumentsDelta: JSON.stringify({ emoji: v.emoji }),
							},
							{ type: 'text', text: v.rest },
						);
						held = '';
						state = 'reacted';
					}
					continue;
				}
				// Reasoning precedes the reply and doesn't decide anything. A tool
				// call does: the reply's opening is over, so let it go first to
				// keep the order.
				if (d.type !== 'reasoning') release();
			}
			if (state === 'reacted') {
				if (d.type === 'tool_call_start' && isReactionTool(d.toolName)) {
					suppressed.add(d.index);
					continue;
				}
				if (d.type === 'tool_call_args_delta' && suppressed.has(d.index)) continue;
			}
			out.push(d);
		}
		// The reply's text is over: whatever is still held was never the shape.
		if (state === 'holding' && (final || r.finishReason || r.done)) release();
		// A caught reply has to read as a tool turn, or the relay never runs the
		// tool and drops the call as unexecuted.
		if (r.finishReason) sawFinish = true;
		let finishReason = r.finishReason;
		if (state === 'reacted') {
			if (finishReason && !INCOMPLETE_FINISH.has(finishReason)) finishReason = 'tool_calls';
			// An upstream that never sent one: the recorder reads the finish reason
			// off the `[DONE]` result, so supply it there.
			else if (!sawFinish && r.done) finishReason = 'tool_calls';
		}
		return { ...r, deltas: out, ...(finishReason !== undefined ? { finishReason } : {}) };
	}

	return {
		process: (record) => transform(inner.process(record), false),
		flush: () => transform(inner.flush(), true),
	};
}
