import { describe, expect, it } from 'vitest';
import {
	capToolResults,
	collapseSupersededSkillActivations,
	serializeBranchForUpstream,
	serializeMessageForUpstream,
	truncateToolResult,
} from '$lib/server/endpoints/serialize-upstream';
import { MediaNotAvailableError } from '$lib/server/media/data-url';
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

	it('degrades a hard-deleted image to a [Image deleted] text note', async () => {
		const resolver = async (id: string) => {
			if (id === 'deleted-img') {
				throw new MediaNotAvailableError(id, 'deleted');
			}
			return `data:image/png;base64,FAKE-${id}`;
		};
		const out = await serializeMessageForUpstream(
			msg('user', [
				{ type: 'text', text: 'what was that?' },
				{ type: 'image', mediaId: 'deleted-img' },
			]),
			resolver,
		);
		expect(out).toEqual({
			role: 'user',
			content: [
				{ type: 'text', text: 'what was that?' },
				{ type: 'text', text: '[Image deleted]' },
			],
		});
	});

	it('preserves live images alongside a deleted one', async () => {
		const resolver = async (id: string) => {
			if (id === 'deleted-img') {
				throw new MediaNotAvailableError(id, 'deleted');
			}
			return `data:image/png;base64,FAKE-${id}`;
		};
		const out = await serializeMessageForUpstream(
			msg('user', [
				{ type: 'text', text: 'compare these' },
				{ type: 'image', mediaId: 'live-img' },
				{ type: 'image', mediaId: 'deleted-img' },
			]),
			resolver,
		);
		expect(out).toEqual({
			role: 'user',
			content: [
				{ type: 'text', text: 'compare these' },
				{ type: 'image_url', image_url: { url: 'data:image/png;base64,FAKE-live-img' } },
				{ type: 'text', text: '[Image deleted]' },
			],
		});
	});

	it('re-throws a non-MediaNotAvailableError from the resolver', async () => {
		const resolver = async () => {
			throw new Error('disk I/O error');
		};
		await expect(
			serializeMessageForUpstream(msg('user', [{ type: 'image', mediaId: 'img-1' }]), resolver),
		).rejects.toThrow('disk I/O error');
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

	it('serializes a branch with a deleted image without crashing', async () => {
		const resolver = async (id: string) => {
			if (id === 'dead-img') throw new MediaNotAvailableError(id, 'deleted');
			return `data:image/png;base64,FAKE-${id}`;
		};
		const branch: ChatMessage[] = [
			msg('user', [{ type: 'text', text: 'describe the image' }], 'u1'),
			msg('user', [{ type: 'image', mediaId: 'dead-img' }], 'u2'),
		];
		const out = await serializeBranchForUpstream(branch, resolver, null);
		expect(out).toHaveLength(2);
		expect(out[0]).toEqual({ role: 'user', content: 'describe the image' });
		expect(out[1]).toEqual({
			role: 'user',
			content: [{ type: 'text', text: '[Image deleted]' }],
		});
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

	it('keeps the FIRST copy full when a re-activation is redundant, and stubs the later one', () => {
		// The cache-critical case, and the common one. Both policies carry the same
		// tokens (one body + one stub); keep-LAST would rewrite the earlier message
		// from 64 KiB down to a stub, changing the MIDDLE of the prompt and forcing
		// the upstream to re-prefill everything after it. Keep-first leaves the
		// earlier message byte-identical and puts the stub at the tail, where the
		// tokens are new anyway — so a redundant reload costs nothing.
		const messages = [
			toolMsg('docx', 'c1'),
			{ role: 'user' as const, content: 'more' },
			toolMsg('docx', 'c2'),
		];
		const out = collapseSupersededSkillActivations(messages);

		// First copy → untouched, byte for byte. This is the property the KV cache
		// depends on.
		expect(out[0]).toEqual(toolMsg('docx', 'c1'));
		// Later copy → placeholder pointing BACK, with the tool_call_id preserved so
		// the assistant's tool_call still pairs to a tool result.
		expect(out[2]).toMatchObject({
			role: 'tool',
			tool_call_id: 'c2',
			content: expect.stringContaining('duplicate="true"'),
		});
		expect(out[2].content).not.toContain('do the thing');
		expect(out[2].content).toMatch(/earlier in this conversation/i);
	});

	it('keeps the post-edit copy when the skill body actually changed', () => {
		// An edit is an asked-for payload change, so it earns its cache invalidation.
		// The stale copy must not be the one the model reads.
		const messages = [
			toolMsg('docx', 'c1'), // old body
			{ role: 'tool' as const, content: skillResult('docx', 'NEW BODY'), tool_call_id: 'c2' },
		];
		const out = collapseSupersededSkillActivations(messages);

		// Stale copy → superseded, pointing FORWARD.
		expect(out[0].content).toContain('superseded="true"');
		expect(out[0].content).toMatch(/below/i);
		// Current copy → kept in full.
		expect(out[1].content).toContain('NEW BODY');
	});

	it('keeps the EARLIEST copy of the current body when an edit is then reloaded again', () => {
		// v1, v2, v2 → the current body first appears at index 1, so that's the copy
		// to keep: the stale v1 is superseded and the redundant third is a duplicate.
		// Keeping index 2 instead would rewrite index 1 for no reason.
		const messages = [
			toolMsg('docx', 'c1'), // v1 (stale)
			{ role: 'tool' as const, content: skillResult('docx', 'V2'), tool_call_id: 'c2' },
			{ role: 'tool' as const, content: skillResult('docx', 'V2'), tool_call_id: 'c3' },
		];
		const out = collapseSupersededSkillActivations(messages);

		expect(out[0].content).toContain('superseded="true"');
		expect(out[1].content).toContain('V2'); // earliest copy of the current body
		expect(out[2].content).toContain('duplicate="true"');
	});

	it('leaves distinct skills alone — only same-name duplicates collapse', () => {
		const messages = [toolMsg('docx', 'c1'), toolMsg('pdf', 'c2'), toolMsg('docx', 'c3')];
		const out = collapseSupersededSkillActivations(messages);

		expect(out[0]).toEqual(toolMsg('docx', 'c1')); // first docx kept full
		expect(out[1]).toEqual(toolMsg('pdf', 'c2')); // lone pdf untouched
		expect(out[2].content).toContain('duplicate="true"'); // redundant docx reload
	});

	it('is idempotent — re-collapsing an already-collapsed payload is a no-op', () => {
		// The transform is recomputed on every request, so it must be a fixed point.
		// The placeholders carry an extra tag attribute precisely so they no longer
		// match SKILL_CONTENT_OPEN.
		const messages = [toolMsg('docx', 'c1'), toolMsg('docx', 'c2'), toolMsg('docx', 'c3')];
		const once = collapseSupersededSkillActivations(messages);
		expect(collapseSupersededSkillActivations(once)).toEqual(once);
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
		// Keep-FIRST: the earlier body is left byte-identical (so the prefix cache
		// survives) and the redundant reload becomes a backward-pointing stub.
		expect(toolResults[0].content).toBe(skillResult('docx'));
		expect(toolResults[1].content).toContain('duplicate="true"');
	});
});

describe('capToolResults', () => {
	const CAP = 1000;

	/** An assistant turn calling `name`, paired with its result. Together these are
	 *  what lets the pass map a result back to the tool that produced it. */
	const exchange = (name: string, callId: string, result: string) => [
		{
			role: 'assistant' as const,
			content: null,
			tool_calls: [{ id: callId, type: 'function' as const, function: { name, arguments: '{}' } }],
		},
		{ role: 'tool' as const, content: result, tool_call_id: callId },
	];

	it('leaves an under-cap result untouched (same array reference, no allocation)', () => {
		const messages = exchange('fetch_url', 'c1', 'short');
		expect(capToolResults(messages, CAP)).toBe(messages);
	});

	it('caps an oversized result and says how much was dropped', () => {
		const huge = 'x'.repeat(50_000);
		const out = capToolResults(exchange('fetch_url', 'c1', huge), CAP);
		const capped = out[1].content as string;

		expect(capped.length).toBeLessThanOrEqual(CAP);
		expect(capped).toContain('characters truncated');

		// The count names what the model is MISSING, and it must be honest: the note
		// occupies budget too, so the true figure is a little larger than
		// (length - cap). The old implementation quoted (length - cap) flat and so
		// understated the loss by exactly the note's own length.
		const reported = Number(/([\d,]+) characters truncated/.exec(capped)![1].replaceAll(',', ''));
		expect(reported).toBeGreaterThanOrEqual(50_000 - CAP);

		// Every 'x' either survived or was counted as dropped — nothing unaccounted for.
		const survivingXs = capped.length - capped.replace(/x/g, '').length;
		expect(survivingXs + reported).toBe(50_000);
	});

	it('keeps the head AND the tail — errors and totals live at the end', () => {
		const body = `HEAD-MARKER${'.'.repeat(50_000)}TAIL-MARKER`;
		const out = capToolResults(exchange('fetch_url', 'c1', body), CAP);

		expect(out[1].content).toContain('HEAD-MARKER');
		expect(out[1].content).toContain('TAIL-MARKER');
	});

	it('never truncates a skill body, however large', () => {
		// A skill body runs to 64 KiB and is INSTRUCTIONS — cutting it mid-sentence
		// corrupts the skill rather than trimming a verbose answer.
		const body = skillResult('research', 'B'.repeat(60_000));
		const out = capToolResults(exchange('activate_skill', 'c1', body), CAP);

		expect(out[1].content).toBe(body);
	});

	it('never truncates a skill resource read', () => {
		const body = 'reference material '.repeat(5000);
		const out = capToolResults(exchange('read_skill_file', 'c1', body), CAP);

		expect(out[1].content).toBe(body);
	});

	it('still spares a skill body whose originating tool_call is not in view', () => {
		// Compaction (or a branch walk) can leave a tool result whose assistant turn
		// isn't in the model-visible slice, so the id → name lookup comes up empty.
		// The wrapper is the fallback signal; without it we'd shred the instructions.
		const orphan = [
			{
				role: 'tool' as const,
				content: skillResult('research', 'B'.repeat(60_000)),
				tool_call_id: 'gone',
			},
		];
		expect(capToolResults(orphan, CAP)[0].content).toBe(orphan[0].content);
	});

	it('is deterministic — the same result caps to the same bytes every turn', () => {
		// This is what keeps the upstream KV/prefix cache valid across a
		// conversation. A scheme that trimmed harder as the thread grew would
		// rewrite the middle of the prompt on every turn.
		const huge = 'y'.repeat(80_000);
		const a = capToolResults(exchange('run_python', 'c1', huge), CAP);
		const b = capToolResults(exchange('run_python', 'c1', huge), CAP);
		expect(a[1].content).toBe(b[1].content);
	});

	it('is idempotent — re-capping an already-capped result changes nothing', () => {
		const once = capToolResults(exchange('fetch_url', 'c1', 'z'.repeat(50_000)), CAP);
		const twice = capToolResults(once, CAP);
		expect(twice[1].content).toBe(once[1].content);
	});

	it('caps nothing when the cap is 0 (disabled)', () => {
		const huge = 'x'.repeat(50_000);
		const messages = exchange('fetch_url', 'c1', huge);
		expect(capToolResults(messages, 0)).toBe(messages);
	});
});

describe('truncateToolResult — JSON results stay parseable', () => {
	/**
	 * EVERY built-in tool sets its result to `JSON.stringify(...)` — fetch_url,
	 * web_search, run_python, recall_memory, search_conversations — and that string
	 * goes on the wire verbatim. A blind character slice cuts through `\uXXXX`
	 * escapes and half-way through records, and the result stops being JSON.
	 *
	 * It's reachable in ordinary use, not adversarially: fetch_url's own content
	 * budget (MAX_CONTENT_CHARS = 20_000) is LARGER than the 16 KiB cap, so a
	 * normal page read trips it.
	 */
	const CAP = 16_384;

	it('keeps a fetch_url envelope valid JSON', () => {
		const page = 'Text with "quotes" and\nnewlines and — em dashes. '.repeat(500);
		const result = JSON.stringify({
			url: 'https://x.test/a',
			status: 200,
			content_type: 'text/html',
			content: page,
			mode: 'full',
		});
		expect(result.length).toBeGreaterThan(CAP);

		const capped = truncateToolResult(result, CAP);
		expect(capped.length).toBeLessThanOrEqual(CAP);

		const parsed = JSON.parse(capped); // would have thrown before
		// The envelope survives — the model can still see what it fetched and that
		// the call succeeded. Only the bulky leaf shrank.
		expect(parsed.url).toBe('https://x.test/a');
		expect(parsed.status).toBe(200);
		expect(parsed.mode).toBe('full');
		expect(parsed.content).toContain('chars truncated');
		expect(parsed.content.length).toBeLessThan(page.length);
	});

	it('does not leave half-cut records in a list-shaped result', () => {
		// The failure that actually bites: a model reading a partially-truncated
		// memory id out of a recall_memory list and then passing it to forget_memory.
		const matches = Array.from({ length: 60 }, (_, i) => ({
			id: `mem-${String(i).padStart(4, '0')}-abcdef`,
			topic: `Topic ${i}`,
			content: `A saved memory about subject number ${i}. `.repeat(20),
		}));
		const result = JSON.stringify({ matches });
		expect(result.length).toBeGreaterThan(CAP);

		const parsed = JSON.parse(truncateToolResult(result, CAP));
		// Every record is still a whole record with an intact id.
		expect(parsed.matches).toHaveLength(60);
		for (const [i, m] of parsed.matches.entries()) {
			expect(m.id).toBe(`mem-${String(i).padStart(4, '0')}-abcdef`);
			expect(m.topic).toBe(`Topic ${i}`);
		}
	});

	it('never splits a unicode escape or a surrogate pair', () => {
		// A lone surrogate half is not valid text and renders as mojibake.
		const body = '😀 café — naïve ✓ '.repeat(2000);
		const result = JSON.stringify({ content: body });
		const capped = truncateToolResult(result, CAP);

		const parsed = JSON.parse(capped);
		expect(parsed.content).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/); // lone high
		expect(parsed.content).not.toMatch(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/); // lone low
	});

	it('is idempotent and deterministic on JSON', () => {
		// Recomputed every request, so it must be a fixed point — and byte-identical
		// each turn, or the prefix cache dies.
		const result = JSON.stringify({ content: 'z'.repeat(40_000) });
		const once = truncateToolResult(result, CAP);
		expect(truncateToolResult(once, CAP)).toBe(once);
		expect(truncateToolResult(result, CAP)).toBe(once);
	});

	it('falls back to a text elision for a non-JSON result', () => {
		const capped = truncateToolResult('q'.repeat(50_000), CAP);
		expect(capped.length).toBeLessThanOrEqual(CAP);
		expect(capped).toContain('characters truncated');
	});

	it('keeps whole records when the bulk is ROWS, not prose', () => {
		// The shape leaf-eliding can't help with: hundreds of short rows, none of them
		// bulky enough to elide, and a per-row note costing more than the row saves.
		// The first cut fell through to character-slicing here and emitted invalid
		// JSON — at the shipped default cap, on the single most plausible oversized
		// MCP payload. Drop rows from the tail instead, and say how many went.
		const rows = Array.from({ length: 300 }, (_, i) => ({
			id: `rec-${String(i).padStart(4, '0')}`,
			fact: `A short fact about subject ${i}, about eighty characters long give or take.`,
		}));
		const result = JSON.stringify({ results: rows });
		expect(result.length).toBeGreaterThan(CAP);

		const capped = truncateToolResult(result, CAP);
		expect(capped.length).toBeLessThanOrEqual(CAP);

		const parsed = JSON.parse(capped); // invalid JSON before
		const kept = parsed.results.filter((r: unknown) => typeof r === 'object');
		expect(kept.length).toBeGreaterThan(0);
		expect(kept.length).toBeLessThan(300);
		// Every surviving record is WHOLE — no half-cut ids.
		for (const [i, r] of kept.entries()) {
			expect(r.id).toBe(`rec-${String(i).padStart(4, '0')}`);
		}
		// And the model is told what it's missing.
		expect(parsed.results.at(-1)).toContain('more items truncated');
	});

	it('emits a valid envelope when the structure itself is irreducible', () => {
		// No bulky leaves, and a single array too short to drop from. Rather than
		// character-slicing (the original bug), degrade to an honest envelope.
		const wide: Record<string, number> = {};
		for (let i = 0; i < 4000; i++) wide[`key_${i}`] = i;
		const result = JSON.stringify(wide);
		expect(result.length).toBeGreaterThan(CAP);

		const capped = truncateToolResult(result, CAP);
		expect(capped.length).toBeLessThanOrEqual(CAP);

		const parsed = JSON.parse(capped);
		expect(parsed.truncated).toBe(true);
		expect(parsed.original_chars).toBe(result.length);
		expect(typeof parsed.preview).toBe('string');
	});

	it('truncates a bare JSON string (the branch that could never fire)', () => {
		// The first cut reserved 64 chars for a note that is 221 long, so this path
		// could not return non-null under any input — it silently fell through to
		// character-slicing. No built-in emits a bare JSON string, but MCP servers may.
		const result = JSON.stringify('z'.repeat(60_000));
		const capped = truncateToolResult(result, CAP);

		expect(capped.length).toBeLessThanOrEqual(CAP);
		const parsed = JSON.parse(capped);
		expect(typeof parsed).toBe('string');
		expect(parsed).toContain('characters truncated');
	});

	it('never exceeds the cap, across shapes and cap sizes', () => {
		const shapes: Record<string, string> = {
			prose: JSON.stringify({ content: 'word '.repeat(20_000) }),
			rows: JSON.stringify({
				r: Array.from({ length: 500 }, (_, i) => ({ id: `id-${i}`, v: 'x'.repeat(60) })),
			}),
			wide: JSON.stringify(
				Object.fromEntries(Array.from({ length: 3000 }, (_, i) => [`k${i}`, i])),
			),
			bare: JSON.stringify('y'.repeat(50_000)),
			text: 'not json '.repeat(6000),
			unicode: JSON.stringify({ content: '😀 café — naïve ✓ '.repeat(3000) }),
		};
		for (const [name, payload] of Object.entries(shapes)) {
			for (const cap of [512, 2048, 8192, 16_384]) {
				const out = truncateToolResult(payload, cap);
				expect(out.length, `${name} @ ${cap}`).toBeLessThanOrEqual(cap);
				// Idempotent: recomputed every request, so it must be a fixed point.
				expect(truncateToolResult(out, cap), `${name} @ ${cap} idempotent`).toBe(out);
				// Deterministic: byte-identical every turn, or the prefix cache dies.
				expect(truncateToolResult(payload, cap), `${name} @ ${cap} deterministic`).toBe(out);
				// JSON in → JSON out. Always.
				if (name !== 'text') expect(() => JSON.parse(out), `${name} @ ${cap} JSON`).not.toThrow();
			}
		}
	});

	it('does not blow the stack on a very large array', () => {
		// `push(...arr)` passes ONE ARGUMENT PER ELEMENT, so a large array threw
		// `RangeError: Maximum call stack size exceeded` — from inside capToolResults,
		// i.e. on the SEND path, not merely the panel. Any MCP server returning a big
		// row/id/number array (~2 MB) reached it.
		const payload = JSON.stringify({ v: Array.from({ length: 300_000 }, (_, i) => i) });
		expect(payload.length).toBeGreaterThan(1_900_000);

		const out = truncateToolResult(payload, CAP); // threw before
		expect(out.length).toBeLessThanOrEqual(CAP);
		const parsed = JSON.parse(out);
		expect(parsed.v.at(-1)).toContain('more items truncated');
	});

	it('preserves number literals too large for a double', () => {
		// Structural truncation round-trips the payload, and a plain
		// JSON.parse→stringify silently rewrites 12345678901234567890 as
		// ...567000 (and 1e400 as null). That's the same "corrupted id fed back to
		// forget_memory" failure this file exists to prevent, arriving by another
		// door — snowflake-style numeric ids from an MCP server are exactly this shape.
		// Hand-written, because JSON.stringify can't produce this literal from a JS
		// number in the first place — which is the whole point.
		const raw = `{"id":12345678901234567890,"content":${JSON.stringify('x'.repeat(40_000))}}`;

		const capped = truncateToolResult(raw, CAP);
		expect(capped.length).toBeLessThanOrEqual(CAP);
		// The id must survive as the EXACT literal, not a rounded double.
		expect(capped).toContain('"id":12345678901234567890');
		expect(capped).not.toContain('12345678901234567000');
		expect(() => JSON.parse(capped)).not.toThrow();
	});

	it('emits a valid envelope for a bare JSON scalar rather than slicing a number', () => {
		// A 40 kB bare number can't be "shortened" and still be that number, so a
		// character slice spliced a prose note into the middle of a digit string.
		const raw = `1${'0'.repeat(40_000)}`;
		expect(() => JSON.parse(raw)).not.toThrow();

		const capped = truncateToolResult(raw, CAP);
		expect(capped.length).toBeLessThanOrEqual(CAP);
		const parsed = JSON.parse(capped);
		expect(parsed.truncated).toBe(true);
	});

	it('stays fast on a large many-leaf payload (no event-loop stall)', () => {
		// The first cut called JSON.stringify on the WHOLE payload inside a per-leaf
		// binary search — ~13 full serializations per leaf, for every leaf. An 850 KB
		// result blocked the single Node process for 4.6 SECONDS. On a self-hosted box
		// that stall is a worse failure than the corrupt JSON it was curing, and it ran
		// on the context-breakdown endpoint too, so opening the panel paid it.
		const payload = JSON.stringify({
			results: Array.from({ length: 1600 }, (_, i) => ({
				id: `rec-${i}`,
				title: `Result ${i}`,
				snippet: 'a fact about something. '.repeat(20),
			})),
		});
		expect(payload.length).toBeGreaterThan(800_000);

		const started = performance.now();
		const out = truncateToolResult(payload, CAP);
		const elapsed = performance.now() - started;

		expect(() => JSON.parse(out)).not.toThrow();
		// Generous ceiling — the point is "milliseconds, not seconds". It was 4,605 ms.
		expect(elapsed).toBeLessThan(400);
	});
});

describe('truncateToolResult', () => {
	it('returns the input unchanged when it fits', () => {
		expect(truncateToolResult('small', 1000)).toBe('small');
	});

	it('never exceeds the cap it was given', () => {
		for (const cap of [200, 1000, 4096]) {
			expect(truncateToolResult('q'.repeat(100_000), cap).length).toBeLessThanOrEqual(cap);
		}
	});

	it('degrades to a bare head when the cap is too tight for the marker', () => {
		// The explanatory marker is ~250 chars. Under a cap that small there's no
		// room to explain, but we must still honour the cap rather than overshoot.
		const out = truncateToolResult('w'.repeat(5000), 50);
		expect(out.length).toBe(50);
		expect(out).toBe('w'.repeat(50));
	});
});
