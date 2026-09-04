/**
 * How a `react_to_message` call becomes a badge on a user bubble.
 *
 * There is no reaction column anywhere: the emoji lives in the tool_call part
 * on the ASSISTANT row, and `buildRenderedConversation` re-attaches it to the
 * user message above by walking the branch. That indirection is what buys the
 * branching behavior for free — `messages` is already the active branch, so a
 * retry's sibling brings its own reaction (or none) and switching siblings
 * switches the badge. These tests pin that, plus the reload half of the
 * suppression: the part must never render as a tool block.
 */

import { describe, expect, it } from 'vitest';
import {
	buildRenderedConversation,
	isReactionTool,
	messageToBlocks,
	parseReactionEmoji,
	type ToolResultEntry,
} from '$lib/chat-render';
import type { ChatMessage, MessagePart } from '$lib/types/api';

function msg(
	id: string,
	role: ChatMessage['role'],
	parts: MessagePart[],
	over: Partial<ChatMessage> = {},
): ChatMessage {
	return {
		id,
		role,
		parts,
		contentHtml: null,
		reasoningText: null,
		finishReason: null,
		modelUsed: null,
		tokensIn: null,
		tokensOut: null,
		genMs: null,
		createdAt: 0,
		...over,
	};
}

const reactionPart = (emoji: string, id = 'call_r'): MessagePart => ({
	type: 'tool_call',
	toolCallId: id,
	toolName: 'react_to_message',
	arguments: JSON.stringify({ emoji }),
});

describe('isReactionTool / parseReactionEmoji', () => {
	it('recognizes the reaction tool and nothing else', () => {
		expect(isReactionTool('react_to_message')).toBe(true);
		expect(isReactionTool('run_python')).toBe(false);
		expect(isReactionTool('mcp__x__react_to_message')).toBe(false);
	});

	it('reads the emoji out of the persisted arguments', () => {
		expect(parseReactionEmoji('{"emoji":"🎉"}')).toBe('🎉');
	});

	it.each([
		['empty args', ''],
		// Half-streamed arguments — the in-flight case.
		['truncated JSON', '{"emo'],
		['no emoji field', '{"mood":"happy"}'],
		['a non-string emoji', '{"emoji":3}'],
	])('returns null for %s', (_label, args) => {
		expect(parseReactionEmoji(args)).toBeNull();
	});
});

describe('messageToBlocks', () => {
	const noResults = new Map<string, ToolResultEntry>();

	it('drops the reaction call, keeping the reply text', () => {
		const blocks = messageToBlocks(
			msg('a1', 'assistant', [{ type: 'text', text: 'Congratulations!' }, reactionPart('🎉')]),
			noResults,
		);
		expect(blocks).toEqual([{ type: 'plain-text', text: 'Congratulations!' }]);
	});

	it('still renders a real tool call sitting beside a reaction', () => {
		const blocks = messageToBlocks(
			msg('a1', 'assistant', [
				reactionPart('🎉'),
				{ type: 'tool_call', toolCallId: 'call_t', toolName: 'get_current_time', arguments: '{}' },
			]),
			noResults,
		);
		expect(blocks).toHaveLength(1);
		expect(blocks[0]).toMatchObject({ type: 'tool_call', toolName: 'get_current_time' });
	});
});

describe('buildRenderedConversation — reactionsByMessageId', () => {
	it('attaches the reaction to the user message above it', () => {
		const { reactionsByMessageId } = buildRenderedConversation([
			msg('u1', 'user', [{ type: 'text', text: 'I got the job!!' }]),
			msg('a1', 'assistant', [{ type: 'text', text: 'Congratulations!' }, reactionPart('🎉')]),
		]);
		expect([...reactionsByMessageId]).toEqual([['u1', '🎉']]);
	});

	it('keeps each turn’s reaction on its own message', () => {
		const { reactionsByMessageId } = buildRenderedConversation([
			msg('u1', 'user', [{ type: 'text', text: 'I got the job!!' }]),
			msg('a1', 'assistant', [{ type: 'text', text: 'Congrats!' }, reactionPart('🎉')]),
			msg('u2', 'user', [{ type: 'text', text: 'and it doubles my pay' }]),
			msg('a2', 'assistant', [{ type: 'text', text: 'Wow.' }, reactionPart('😮', 'call_r2')]),
		]);
		expect(reactionsByMessageId.get('u1')).toBe('🎉');
		expect(reactionsByMessageId.get('u2')).toBe('😮');
	});

	it('records nothing for a turn with no reaction', () => {
		const { reactionsByMessageId } = buildRenderedConversation([
			msg('u1', 'user', [{ type: 'text', text: 'what is 2+2' }]),
			msg('a1', 'assistant', [{ type: 'text', text: '4' }]),
		]);
		expect(reactionsByMessageId.size).toBe(0);
	});

	it('follows the branch: only the assistant sibling on it contributes', () => {
		// A retry appends a sibling under the same user message. `messages` is the
		// ACTIVE branch, so whichever sibling is on it is the one whose reaction
		// shows — this is the whole reason the emoji lives on the assistant row
		// instead of a column on the user row, where the last retry would win.
		const branchWithReaction = buildRenderedConversation([
			msg('u1', 'user', [{ type: 'text', text: 'I got the job!!' }]),
			msg('a1', 'assistant', [{ type: 'text', text: 'Congrats!' }, reactionPart('🎉')]),
		]);
		const branchWithout = buildRenderedConversation([
			msg('u1', 'user', [{ type: 'text', text: 'I got the job!!' }]),
			msg('a2', 'assistant', [{ type: 'text', text: 'Noted.' }]),
		]);
		expect(branchWithReaction.reactionsByMessageId.get('u1')).toBe('🎉');
		expect(branchWithout.reactionsByMessageId.has('u1')).toBe(false);
	});

	it('takes the last reaction when a multi-iteration turn reacts twice', () => {
		const { reactionsByMessageId } = buildRenderedConversation([
			msg('u1', 'user', [{ type: 'text', text: 'look at this' }]),
			msg('a1', 'assistant', [{ type: 'text', text: 'One sec.' }, reactionPart('👀')]),
			msg('t1', 'tool', [{ type: 'tool_result', toolCallId: 'call_r', result: 'ok' }]),
			msg('a2', 'assistant', [{ type: 'text', text: 'Nice!' }, reactionPart('😍', 'call_r2')]),
		]);
		expect(reactionsByMessageId.get('u1')).toBe('😍');
	});

	it('ignores a reaction whose arguments never finished streaming', () => {
		const { reactionsByMessageId } = buildRenderedConversation([
			msg('u1', 'user', [{ type: 'text', text: 'hi' }]),
			msg('a1', 'assistant', [
				{ type: 'text', text: 'hey' },
				{
					type: 'tool_call',
					toolCallId: 'call_r',
					toolName: 'react_to_message',
					arguments: '{"em',
				},
			]),
		]);
		expect(reactionsByMessageId.size).toBe(0);
	});
});
