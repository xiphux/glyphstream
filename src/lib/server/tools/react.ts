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
 *    back — by the SHARED predicate in `$lib/chat-render`, because the relay's
 *    recorder persists a tool call's arguments before the tool runs, so the
 *    renderer has to apply the same check to the durable record.
 *
 * When the model reacts AND writes in the same message, the turn does not
 * round-trip upstream for it: `relay.ts` short-circuits the tool loop, so the
 * reaction costs its own tokens and nothing else.
 *
 * Whether that condition holds is not ours to decide — plenty of chat templates
 * make `content` and `tool_calls` mutually exclusive, and against those the
 * model reacts in one iteration (`content: ''`, `finish_reason: 'tool_calls'`)
 * and writes in the next, so the short-circuit never fires. Both shapes are
 * handled and tested; the difference is only cost. Don't tune this to whichever
 * model is in front of it today — the loop already does the right thing either
 * way, and the extra iteration is the same one any tool call pays for.
 */

import { register } from './registry';
import type { Tool } from './types';
// Client-safe module, imported server-side on purpose — the same trick
// `relay.ts` uses for CODE_ARG_TOOLS. The renderer has to know this name too
// (to drop the part), and one constant in a shared module is the only way the
// two halves of "this tool is invisible" can't drift apart.
import { REACTION_TOOL_NAME, validateEmoji } from '$lib/chat-render';

export const reactToMessageTool: Tool = {
	definition: {
		type: 'function',
		function: {
			name: REACTION_TOOL_NAME,
			// Budgeted (tool-definition-budget.test.ts). Every sentence here is
			// re-sent on every turn of every conversation with reactions on, so
			// it says only what the model can't infer: that the reaction is
			// silent, that reacting does not cost it the reply, and how its RATE
			// depends on the register.
			//
			// That last part was three suppressants to one weak permission —
			// "use it sparingly", "most messages deserve none", "reacting to
			// everything reads as insincere", then a vague "warmth and banter
			// earn more". Read together that is an instruction not to react, and
			// the observed behaviour matched: nothing across a long warm
			// conversation, while an explicit request worked fine. The absolute
			// is now a conditional rate, so the warm case gets a number to aim
			// at instead of an exception to a prohibition.
			//
			// "You do not lose your reply" is aimed at a SECOND disincentive, and
			// the one more likely to be doing the damage. It is phrased as the
			// reply surviving rather than the reaction being free, because under
			// the very template this targets the reaction does cost an extra
			// round-trip — the header above says so, and a description that
			// claimed otherwise would be contradicted by its own file. Under a
			// template where content and tool_calls are mutually exclusive,
			// reacting means
			// emitting a turn with no prose in it and picking the reply up on the
			// next iteration — so at decode time the model isn't weighing "add an
			// emoji?" but "say nothing this turn?", which in an immersive
			// conversation it will always decline. The model can't see that the
			// loop hands the reply back, so the description has to tell it.
			//
			// Measured once against a model of that class, not tuned to it: of
			// the single reaction the instance had produced, the emoji arrived
			// alone and the text came in a second row. The lever is the template
			// shape, which any model may have — see the header.
			description:
				"React to the user's latest message with one emoji, as in a messaging app. Never announce or mention it — it just appears, or it isn't a reaction. You do not lose your reply: it still follows. How often is a matter of register: in warm, personal or playful talk, every few messages is natural; in technical or task-focused work, rarely or never.",
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
	execute(args, ctx) {
		// Execute-time gate, matching the canvas tools. The registry's
		// `excludeCategories` filter only controls what gets ADVERTISED, and
		// `executeOneToolCall` looks a tool up by name with no check against what
		// this turn actually offered — so a model that sees its own past reactions
		// in the history will keep calling this after the toggle goes off. Without
		// this the badge still lands and the toggle looks broken.
		if (ctx.disabledFeatures.includes('reactions')) {
			return { content: 'Reactions are disabled for this conversation.', isError: true };
		}
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
		// lets the badge land before the post-`done` refetch. Note it is NOT the
		// only gate — the recorder persisted the raw arguments before we ran, so
		// the renderer re-validates the same way (see parseReactionEmoji).
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

/** Re-exported so the tool's own tests and callers don't have to know the
 *  predicate lives in the client-safe module. See the note there for why it
 *  does: the renderer reads a record persisted BEFORE this tool ever runs, so
 *  both ends have to apply the same check or the durable one goes unvalidated. */
export { validateEmoji };

register(reactToMessageTool);
