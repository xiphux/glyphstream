/**
 * `react_to_message` — the assistant taps an emoji reaction onto the user's
 * last message, the way a person does in iMessage / Messenger.
 *
 * Three things about this tool are deliberate and load-bearing:
 *
 * 1. **It stores nothing.** The reaction IS the `tool_call` part the relay
 *    already persists on the assistant row — `{"emoji":"🙂"}` in `arguments`.
 *    No column, no migration, and the tree semantics come free: a retry makes a
 *    sibling assistant under the same user message, so switching branches
 *    switches the reaction with it. Storing it on the USER row instead would
 *    let the last retry clobber the first and show the wrong emoji after a
 *    `‹ 2/3 ›` navigation.
 *
 * 2. **It's invisible.** The relay suppresses its `tool_call_start` /
 *    `tool_call_args_delta` frames and the tool-execution stage emits a single
 *    `reaction` event in place of `executing` / `result`; the client drops the
 *    persisted part in `messageToBlocks`. A reaction that announces itself
 *    first isn't a reaction.
 *
 * 3. **No enum of "common" emoji.** Messaging apps ship a six-emoji quick bar
 *    because a human needs a one-tap affordance; a model has no tap cost. An
 *    enum would be `tools[]` rent on every turn forever to restate something the
 *    model already knows, and — worse — it would bias hard toward those six,
 *    which is exactly the "gets old fast" failure this feature has to avoid.
 *    The register is described instead, and the value is validated on the way
 *    back.
 *
 * The turn does NOT round-trip upstream for this: `relay.ts` short-circuits the
 * tool loop when the only calls in an iteration are reactions and the model
 * already wrote text, so a reaction costs its own tokens and nothing else.
 */

import { register } from './registry';
import type { Tool } from './types';
// Client-safe module, imported server-side on purpose — the same trick
// `relay.ts` uses for CODE_ARG_TOOLS. The renderer has to know this name too
// (to drop the part), and one constant in a shared module is the only way the
// two halves of "this tool is invisible" can't drift apart.
import { REACTION_TOOL_NAME } from '$lib/chat-render';

export const reactToMessageTool: Tool = {
	definition: {
		type: 'function',
		function: {
			name: REACTION_TOOL_NAME,
			// Budgeted (tool-definition-budget.test.ts). Every sentence here is
			// re-sent on every turn of every conversation with reactions on, so
			// it says only what the model can't infer: that the reaction is
			// silent, that it is occasional, and that it does not replace a reply.
			description:
				"React to the user's latest message with one emoji, as in a messaging app. Never announce or mention it — it just appears, or it isn't a reaction. Use it sparingly: most messages deserve none, and reacting to everything reads as insincere. Warmth and banter earn more; technical or task-focused exchanges earn few or none. Never a replacement for replying.",
			parameters: {
				type: 'object',
				properties: {
					emoji: {
						type: 'string',
						description:
							'One emoji — the kind a person taps as a reaction: faces, hands, hearts. Not objects, symbols or text.',
					},
				},
				required: ['emoji'],
				additionalProperties: false,
			},
		},
	},
	metadata: { displayLabel: 'Reaction', icon: 'smile', category: 'reactions' },
	execute(args) {
		const emoji = parseEmojiArg(args);
		if (!emoji) {
			return {
				content: 'Not a single emoji; no reaction was added.',
				isError: true,
			};
		}
		// Terse ack, on purpose. It's re-sent on every later turn of the
		// conversation, and the emoji is already in the tool_call arguments
		// sitting right above it. Its one job is to let the model see its own
		// reaction history — which is the only damper on reacting too often
		// that doesn't cost anything or shuffle the payload.
		//
		// `reaction` is the live-tick side channel, symmetric with the canvas
		// tools' `canvas`: the durable record is the tool_call part, this just
		// lets the badge land before the post-`done` refetch. Returning the
		// VALIDATED value (not re-parsing the raw args downstream) keeps the
		// one definition of "is this an emoji" in this module.
		return { content: 'ok', reaction: emoji };
	},
};

/** Extract and validate the `emoji` argument. Returns the normalized emoji, or
 *  null when the model sent something that isn't one. */
export function parseEmojiArg(args: unknown): string | null {
	if (!args || typeof args !== 'object' || !('emoji' in args)) return null;
	// `'emoji' in args` narrows args, so no assertion is needed here.
	const raw: unknown = args.emoji;
	if (typeof raw !== 'string') return null;
	return validateEmoji(raw);
}

/**
 * Whether a string is exactly one emoji, and the normalized form if so.
 *
 * Two conditions, both needed:
 *  - **One grapheme** (`Intl.Segmenter`), so `"👍👍"`, `"🙂 nice"` and a bare
 *    sentence are all rejected. A ZWJ family or a skin-tone modifier is a
 *    single grapheme, so those pass — correctly, they're one reaction.
 *  - **Contains an Extended_Pictographic code point**, which is what separates
 *    an emoji from a letter. It also rejects the two single-grapheme cases that
 *    would otherwise slip through and look like junk on a message bubble: flags
 *    (regional-indicator pairs) and keycaps (`1️⃣`), neither of which has a
 *    pictographic base.
 *
 * The length guard runs first so a model that streams a paragraph into the
 * field doesn't get segmented word by word.
 */
export function validateEmoji(raw: string): string | null {
	const trimmed = raw.trim();
	// A ZWJ sequence with skin tones is the longest legitimate case and sits
	// comfortably under this; anything longer is prose, not a reaction.
	if (trimmed.length === 0 || trimmed.length > 32) return null;
	if (!/\p{Extended_Pictographic}/u.test(trimmed)) return null;
	const segmenter = new Intl.Segmenter('en', { granularity: 'grapheme' });
	return [...segmenter.segment(trimmed)].length === 1 ? trimmed : null;
}

register(reactToMessageTool);
