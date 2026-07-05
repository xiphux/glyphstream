import { describe, expect, it } from 'vitest';
import {
	collapseSupersededSkillActivations,
	serializeBranchForUpstream,
	serializeMessageForUpstream,
} from '$lib/server/endpoints/serialize-upstream';
import type { ChatMessage, MessagePart } from '$lib/types/api';

/** A full `activate_skill` tool result as `wrapSkillContent` persists it — the
 *  first line is the marker the collapse pass keys on. */
function skillResult(name: string, body = 'do the thing'): string {
	return `<skill_content name="${name}">\n\n${body}\n\n</skill_content>`;
}

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
		genMs: null,
		createdAt: 0,
	};
}

const noMedia = async () => {
	throw new Error('media resolver should not have been called');
};

describe('serializeMessageForUpstream', () => {
	it('serializes a plain user message as bare-string content', async () => {
		const out = await serializeMessageForUpstream(
			msg('user', [{ type: 'text', text: 'hello' }]),
			noMedia,
		);
		expect(out).toEqual({ role: 'user', content: 'hello' });
	});

	it('joins multiple text parts in a single message', async () => {
		const out = await serializeMessageForUpstream(
			msg('user', [
				{ type: 'text', text: 'one ' },
				{ type: 'text', text: 'two' },
			]),
			noMedia,
		);
		expect(out).toEqual({ role: 'user', content: 'one two' });
	});

	it('skips a failed media branch (error-only assistant message) entirely', async () => {
		// A failed image/video branch persists as an assistant message carrying
		// only an `error` part — kept for recovery/display, but it has no upstream
		// wire form, so it must be dropped rather than sent as an empty turn.
		const out = await serializeMessageForUpstream(
			msg('assistant', [{ type: 'error', message: 'render crashed' }]),
			noMedia,
		);
		expect(out).toBeNull();
	});

	it('serializeBranchForUpstream omits a failed branch from the request', async () => {
		const out = await serializeBranchForUpstream(
			[
				msg('user', [{ type: 'text', text: 'make a video' }], 'u1'),
				msg('assistant', [{ type: 'error', message: 'job timed out' }], 'a1'),
			],
			noMedia,
			null,
		);
		expect(out).toEqual([{ role: 'user', content: 'make a video' }]);
	});

	it('drops reasoning parts when serializing for upstream', async () => {
		// Reasoning is for display, not for echoing back to the model.
		const out = await serializeMessageForUpstream(
			msg('assistant', [
				{ type: 'reasoning', text: 'thinking...' },
				{ type: 'text', text: 'the answer' },
			]),
			noMedia,
		);
		expect(out).toEqual({ role: 'assistant', content: 'the answer' });
	});

	it('serializes an image-bearing message via the vision content array', async () => {
		const out = await serializeMessageForUpstream(
			msg('user', [
				{ type: 'text', text: 'what is this?' },
				{ type: 'image', mediaId: 'media-abc' },
			]),
			async (id) => `data:image/png;base64,FAKE-${id}`,
		);
		expect(out).toEqual({
			role: 'user',
			content: [
				{ type: 'text', text: 'what is this?' },
				{ type: 'image_url', image_url: { url: 'data:image/png;base64,FAKE-media-abc' } },
			],
		});
	});

	it('notes a file attachment in text so the model knows it exists', async () => {
		const out = await serializeMessageForUpstream(
			msg('user', [
				{ type: 'text', text: 'combine these' },
				{ type: 'file', mediaId: 'm-a', filename: 'a.pdf', byteSize: 10 },
				{ type: 'file', mediaId: 'm-b', filename: 'b.pdf', byteSize: 20 },
			]),
			noMedia,
		);
		expect(out).toEqual({
			role: 'user',
			content: 'combine these\n\n[Attached files: a.pdf, b.pdf]',
		});
	});

	it('notes a file-only message (no text) as just the attachment line', async () => {
		const out = await serializeMessageForUpstream(
			msg('user', [{ type: 'file', mediaId: 'm-a', filename: 'report.pdf', byteSize: 10 }]),
			noMedia,
		);
		expect(out).toEqual({ role: 'user', content: '[Attached file: report.pdf]' });
	});

	it('appends the file note as a text part alongside images', async () => {
		const out = await serializeMessageForUpstream(
			msg('user', [
				{ type: 'text', text: 'use these' },
				{ type: 'image', mediaId: 'img-1' },
				{ type: 'file', mediaId: 'm-a', filename: 'data.csv', byteSize: 10 },
			]),
			async (id) => `data:image/png;base64,FAKE-${id}`,
		);
		expect(out).toEqual({
			role: 'user',
			content: [
				{ type: 'text', text: 'use these' },
				{ type: 'image_url', image_url: { url: 'data:image/png;base64,FAKE-img-1' } },
				{ type: 'text', text: '[Attached file: data.csv]' },
			],
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
					arguments: '{"timezone":"UTC"}',
				},
			]),
			noMedia,
		);
		expect(out).toEqual({
			role: 'assistant',
			content: 'let me check the time',
			tool_calls: [
				{
					id: 'call_abc',
					type: 'function',
					function: { name: 'get_current_time', arguments: '{"timezone":"UTC"}' },
				},
			],
		});
	});

	it('sends null content when an assistant emits only tool_calls (no prose)', async () => {
		const out = await serializeMessageForUpstream(
			msg('assistant', [
				{
					type: 'tool_call',
					toolCallId: 'call_xyz',
					toolName: 'get_current_time',
					arguments: '{}',
				},
			]),
			noMedia,
		);
		expect(out).toEqual({
			role: 'assistant',
			content: null,
			tool_calls: [
				{
					id: 'call_xyz',
					type: 'function',
					function: { name: 'get_current_time', arguments: '{}' },
				},
			],
		});
	});

	it('preserves parallel tool_calls in their original order', async () => {
		const out = await serializeMessageForUpstream(
			msg('assistant', [
				{ type: 'tool_call', toolCallId: 'a', toolName: 't1', arguments: '{}' },
				{ type: 'tool_call', toolCallId: 'b', toolName: 't2', arguments: '{}' },
			]),
			noMedia,
		);
		expect(out?.tool_calls).toEqual([
			{ id: 'a', type: 'function', function: { name: 't1', arguments: '{}' } },
			{ id: 'b', type: 'function', function: { name: 't2', arguments: '{}' } },
		]);
	});

	it('serializes a tool result message with tool_call_id', async () => {
		const out = await serializeMessageForUpstream(
			msg('tool', [
				{ type: 'tool_result', toolCallId: 'call_abc', result: '{"iso":"2026-05-26T00:00:00Z"}' },
			]),
			noMedia,
		);
		expect(out).toEqual({
			role: 'tool',
			tool_call_id: 'call_abc',
			content: '{"iso":"2026-05-26T00:00:00Z"}',
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
			'You are helpful.',
		);
		expect(out).toEqual([
			{ role: 'system', content: 'You are helpful.' },
			{ role: 'user', content: 'hi' },
		]);
	});

	it('omits the system message when systemPrompt is null', async () => {
		const out = await serializeBranchForUpstream(
			[msg('user', [{ type: 'text', text: 'hi' }])],
			noMedia,
			null,
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
						arguments: '{"timezone":"Asia/Tokyo"}',
					},
				],
				'a1',
			),
			msg(
				'tool',
				[{ type: 'tool_result', toolCallId: 'call_1', result: '{"iso":"2026-05-26T00:00:00Z"}' }],
				't1',
			),
			msg('assistant', [{ type: 'text', text: "It's 9 AM in Tokyo." }], 'a2'),
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
						function: { name: 'get_current_time', arguments: '{"timezone":"Asia/Tokyo"}' },
					},
				],
			},
			{
				role: 'tool',
				tool_call_id: 'call_1',
				content: '{"iso":"2026-05-26T00:00:00Z"}',
			},
			{ role: 'assistant', content: "It's 9 AM in Tokyo." },
		]);
	});

	it('handles parallel tool calls: one assistant with multiple tool_calls and matching tool messages', async () => {
		const branch: ChatMessage[] = [
			msg('user', [{ type: 'text', text: 'time in Tokyo and London' }], 'u1'),
			msg(
				'assistant',
				[
					{
						type: 'tool_call',
						toolCallId: 'a',
						toolName: 'get_current_time',
						arguments: '{"timezone":"Asia/Tokyo"}',
					},
					{
						type: 'tool_call',
						toolCallId: 'b',
						toolName: 'get_current_time',
						arguments: '{"timezone":"Europe/London"}',
					},
				],
				'asst1',
			),
			msg('tool', [{ type: 'tool_result', toolCallId: 'a', result: 'tokyo time' }], 't1'),
			msg('tool', [{ type: 'tool_result', toolCallId: 'b', result: 'london time' }], 't2'),
		];
		const out = await serializeBranchForUpstream(branch, noMedia, null);
		expect(out).toHaveLength(4);
		expect(out[1].tool_calls).toHaveLength(2);
		expect(out[2]).toMatchObject({ role: 'tool', tool_call_id: 'a' });
		expect(out[3]).toMatchObject({ role: 'tool', tool_call_id: 'b' });
	});

	it('trims a compacted branch: leads with the summary, drops summarized turns, keeps the verbatim tail', async () => {
		// u0 a0 u1 a1 u2 a2 S(resume=u2) — the summary stands in for u0..a1.
		const branch: ChatMessage[] = [
			msg('user', [{ type: 'text', text: 'q0' }], 'u0'),
			msg('assistant', [{ type: 'text', text: 'r0' }], 'a0'),
			msg('user', [{ type: 'text', text: 'q1' }], 'u1'),
			msg('assistant', [{ type: 'text', text: 'r1' }], 'a1'),
			msg('user', [{ type: 'text', text: 'q2' }], 'u2'),
			msg('assistant', [{ type: 'text', text: 'r2' }], 'a2'),
			{
				...msg('assistant', [{ type: 'text', text: 'SUMMARY of q0..r1' }], 'S'),
				compactionResumeFromMessageId: 'u2',
			},
		];
		const out = await serializeBranchForUpstream(branch, noMedia, 'sys');
		expect(out).toEqual([
			{ role: 'system', content: 'sys' },
			{ role: 'assistant', content: 'SUMMARY of q0..r1' },
			{ role: 'user', content: 'q2' },
			{ role: 'assistant', content: 'r2' },
		]);
	});
});

describe('collapseSupersededSkillActivations', () => {
	const toolMsg = (name: string, callId: string) => ({
		role: 'tool' as const,
		content: skillResult(name),
		tool_call_id: callId,
	});

	it('keeps a lone activation untouched (same array reference, no allocation)', () => {
		const messages = [{ role: 'user' as const, content: 'hi' }, toolMsg('docx', 'c1')];
		expect(collapseSupersededSkillActivations(messages)).toBe(messages);
	});

	it('collapses the earlier of two same-skill activations, keeps the latest full', () => {
		const messages = [
			toolMsg('docx', 'c1'),
			{ role: 'user' as const, content: 'more' },
			toolMsg('docx', 'c2'),
		];
		const out = collapseSupersededSkillActivations(messages);

		// Earlier copy → placeholder, but the tool_call_id is preserved so the
		// assistant's tool_call still pairs to a tool result.
		expect(out[0]).toMatchObject({
			role: 'tool',
			tool_call_id: 'c1',
			content: expect.stringContaining('superseded="true"'),
		});
		expect(out[0].content).not.toContain('do the thing');
		// Latest copy → full, unchanged.
		expect(out[2]).toEqual(toolMsg('docx', 'c2'));
	});

	it('leaves distinct skills alone — only same-name duplicates collapse', () => {
		const messages = [toolMsg('docx', 'c1'), toolMsg('pdf', 'c2'), toolMsg('docx', 'c3')];
		const out = collapseSupersededSkillActivations(messages);

		expect(out[0].content).toContain('superseded="true"'); // first docx
		expect(out[1]).toEqual(toolMsg('pdf', 'c2')); // lone pdf untouched
		expect(out[2]).toEqual(toolMsg('docx', 'c3')); // latest docx full
	});

	it('ignores non-skill tool results (regular tools are never collapsed)', () => {
		const messages = [
			{ role: 'tool' as const, content: '{"weather":"sunny"}', tool_call_id: 'c1' },
			{ role: 'tool' as const, content: '{"weather":"rainy"}', tool_call_id: 'c2' },
		];
		expect(collapseSupersededSkillActivations(messages)).toBe(messages);
	});

	it('is idempotent — placeholders are not re-detected as activations', () => {
		const messages = [toolMsg('docx', 'c1'), toolMsg('docx', 'c2')];
		const once = collapseSupersededSkillActivations(messages);
		const twice = collapseSupersededSkillActivations(once);
		expect(twice).toEqual(once);
	});

	it('collapses through the full branch serializer (send-time choke point)', async () => {
		// user → a(tool_call) → tool(docx) → a(tool_call) → tool(docx again)
		const branch: ChatMessage[] = [
			msg('user', [{ type: 'text', text: 'edit my doc' }], 'u0'),
			msg(
				'assistant',
				[
					{
						type: 'tool_call',
						toolCallId: 'c1',
						toolName: 'activate_skill',
						arguments: '{"name":"docx"}',
					},
				],
				'a0',
			),
			msg('tool', [{ type: 'tool_result', toolCallId: 'c1', result: skillResult('docx') }], 't0'),
			msg(
				'assistant',
				[
					{
						type: 'tool_call',
						toolCallId: 'c2',
						toolName: 'activate_skill',
						arguments: '{"name":"docx"}',
					},
				],
				'a1',
			),
			msg('tool', [{ type: 'tool_result', toolCallId: 'c2', result: skillResult('docx') }], 't1'),
		];
		const out = await serializeBranchForUpstream(branch, noMedia, null);

		const toolResults = out.filter((m) => m.role === 'tool');
		expect(toolResults[0].content).toContain('superseded="true"');
		expect(toolResults[1].content).toBe(skillResult('docx'));
	});
});
