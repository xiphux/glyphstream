import { describe, expect, it } from 'vitest';
import {
	serializeBranchForUpstream,
	serializeMessageForUpstream
} from '$lib/server/endpoints/serialize-upstream';
import type { ChatMessage, MessagePart } from '$lib/types/api';

function msg(role: ChatMessage['role'], parts: MessagePart[], id = 'm1'): ChatMessage {
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
		createdAt: 0
	};
}

const noMedia = async () => {
	throw new Error('media resolver should not have been called');
};

describe('serializeMessageForUpstream', () => {
	it('serializes a plain user message as bare-string content', async () => {
		const out = await serializeMessageForUpstream(
			msg('user', [{ type: 'text', text: 'hello' }]),
			noMedia
		);
		expect(out).toEqual({ role: 'user', content: 'hello' });
	});

	it('joins multiple text parts in a single message', async () => {
		const out = await serializeMessageForUpstream(
			msg('user', [
				{ type: 'text', text: 'one ' },
				{ type: 'text', text: 'two' }
			]),
			noMedia
		);
		expect(out).toEqual({ role: 'user', content: 'one two' });
	});

	it('drops reasoning parts when serializing for upstream', async () => {
		// Reasoning is for display, not for echoing back to the model.
		const out = await serializeMessageForUpstream(
			msg('assistant', [
				{ type: 'reasoning', text: 'thinking...' },
				{ type: 'text', text: 'the answer' }
			]),
			noMedia
		);
		expect(out).toEqual({ role: 'assistant', content: 'the answer' });
	});

	it('serializes an image-bearing message via the vision content array', async () => {
		const out = await serializeMessageForUpstream(
			msg('user', [
				{ type: 'text', text: 'what is this?' },
				{ type: 'image', mediaId: 'media-abc' }
			]),
			async (id) => `data:image/png;base64,FAKE-${id}`
		);
		expect(out).toEqual({
			role: 'user',
			content: [
				{ type: 'text', text: 'what is this?' },
				{ type: 'image_url', image_url: { url: 'data:image/png;base64,FAKE-media-abc' } }
			]
		});
	});

	it('serializes an assistant message with a tool_call into the OpenAI tool_calls shape', async () => {
		const out = await serializeMessageForUpstream(
			msg('assistant', [
				{ type: 'text', text: 'let me check the time' },
				{
					type: 'tool_call',
					toolCallId: 'call_abc',
					toolName: 'get_current_time',
					arguments: '{"timezone":"UTC"}'
				}
			]),
			noMedia
		);
		expect(out).toEqual({
			role: 'assistant',
			content: 'let me check the time',
			tool_calls: [
				{
					id: 'call_abc',
					type: 'function',
					function: { name: 'get_current_time', arguments: '{"timezone":"UTC"}' }
				}
			]
		});
	});

	it('sends null content when an assistant emits only tool_calls (no prose)', async () => {
		const out = await serializeMessageForUpstream(
			msg('assistant', [
				{
					type: 'tool_call',
					toolCallId: 'call_xyz',
					toolName: 'get_current_time',
					arguments: '{}'
				}
			]),
			noMedia
		);
		expect(out).toEqual({
			role: 'assistant',
			content: null,
			tool_calls: [
				{
					id: 'call_xyz',
					type: 'function',
					function: { name: 'get_current_time', arguments: '{}' }
				}
			]
		});
	});

	it('preserves parallel tool_calls in their original order', async () => {
		const out = await serializeMessageForUpstream(
			msg('assistant', [
				{ type: 'tool_call', toolCallId: 'a', toolName: 't1', arguments: '{}' },
				{ type: 'tool_call', toolCallId: 'b', toolName: 't2', arguments: '{}' }
			]),
			noMedia
		);
		expect(out?.tool_calls).toEqual([
			{ id: 'a', type: 'function', function: { name: 't1', arguments: '{}' } },
			{ id: 'b', type: 'function', function: { name: 't2', arguments: '{}' } }
		]);
	});

	it('serializes a tool result message with tool_call_id', async () => {
		const out = await serializeMessageForUpstream(
			msg('tool', [
				{ type: 'tool_result', toolCallId: 'call_abc', result: '{"iso":"2026-05-26T00:00:00Z"}' }
			]),
			noMedia
		);
		expect(out).toEqual({
			role: 'tool',
			tool_call_id: 'call_abc',
			content: '{"iso":"2026-05-26T00:00:00Z"}'
		});
	});

	it('returns null for a tool message that has no tool_result part (defensive)', async () => {
		const out = await serializeMessageForUpstream(msg('tool', []), noMedia);
		expect(out).toBeNull();
	});
});

describe('serializeBranchForUpstream', () => {
	it('prepends the system prompt when supplied', async () => {
		const out = await serializeBranchForUpstream(
			[msg('user', [{ type: 'text', text: 'hi' }])],
			noMedia,
			'You are helpful.'
		);
		expect(out).toEqual([
			{ role: 'system', content: 'You are helpful.' },
			{ role: 'user', content: 'hi' }
		]);
	});

	it('omits the system message when systemPrompt is null', async () => {
		const out = await serializeBranchForUpstream(
			[msg('user', [{ type: 'text', text: 'hi' }])],
			noMedia,
			null
		);
		expect(out).toEqual([{ role: 'user', content: 'hi' }]);
	});

	it('round-trips a full tool-using turn: user → assistant(tool_call) → tool → assistant', async () => {
		// This is the OpenAI wire shape after one tool round-trip — the
		// real-world output of the relay loop in PRs 4-5. Verifies the
		// serialized sequence is exactly what we'd post upstream on the
		// follow-up request.
		const branch: ChatMessage[] = [
			msg('user', [{ type: 'text', text: 'what time is it in Tokyo?' }], 'u1'),
			msg(
				'assistant',
				[
					{
						type: 'tool_call',
						toolCallId: 'call_1',
						toolName: 'get_current_time',
						arguments: '{"timezone":"Asia/Tokyo"}'
					}
				],
				'a1'
			),
			msg(
				'tool',
				[{ type: 'tool_result', toolCallId: 'call_1', result: '{"iso":"2026-05-26T00:00:00Z"}' }],
				't1'
			),
			msg('assistant', [{ type: 'text', text: "It's 9 AM in Tokyo." }], 'a2')
		];
		const out = await serializeBranchForUpstream(branch, noMedia, null);
		expect(out).toEqual([
			{ role: 'user', content: 'what time is it in Tokyo?' },
			{
				role: 'assistant',
				content: null,
				tool_calls: [
					{
						id: 'call_1',
						type: 'function',
						function: { name: 'get_current_time', arguments: '{"timezone":"Asia/Tokyo"}' }
					}
				]
			},
			{
				role: 'tool',
				tool_call_id: 'call_1',
				content: '{"iso":"2026-05-26T00:00:00Z"}'
			},
			{ role: 'assistant', content: "It's 9 AM in Tokyo." }
		]);
	});

	it('handles parallel tool calls: one assistant with multiple tool_calls and matching tool messages', async () => {
		const branch: ChatMessage[] = [
			msg('user', [{ type: 'text', text: 'time in Tokyo and London' }], 'u1'),
			msg(
				'assistant',
				[
					{ type: 'tool_call', toolCallId: 'a', toolName: 'get_current_time', arguments: '{"timezone":"Asia/Tokyo"}' },
					{ type: 'tool_call', toolCallId: 'b', toolName: 'get_current_time', arguments: '{"timezone":"Europe/London"}' }
				],
				'asst1'
			),
			msg('tool', [{ type: 'tool_result', toolCallId: 'a', result: 'tokyo time' }], 't1'),
			msg('tool', [{ type: 'tool_result', toolCallId: 'b', result: 'london time' }], 't2')
		];
		const out = await serializeBranchForUpstream(branch, noMedia, null);
		expect(out).toHaveLength(4);
		expect(out[1].tool_calls).toHaveLength(2);
		expect(out[2]).toMatchObject({ role: 'tool', tool_call_id: 'a' });
		expect(out[3]).toMatchObject({ role: 'tool', tool_call_id: 'b' });
	});
});
