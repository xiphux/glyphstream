import { describe, expect, it } from 'vitest';
import { createNormalizer } from '$lib/server/streaming/normalizers';
import type { SSERecord } from '$lib/server/streaming/sse-parser';

/**
 * SSE records the way the parser hands them to the normalizer: just the
 * `data:` payload. Test helpers shape these directly.
 */
function rec(data: string): SSERecord {
	return { event: '', data };
}

function chunk(opts: {
	content?: string;
	reasoning?: string;
	reasoning_content?: string;
	finish_reason?: string;
}): string {
	const delta: Record<string, unknown> = {};
	if (opts.content !== undefined) delta.content = opts.content;
	if (opts.reasoning !== undefined) delta.reasoning = opts.reasoning;
	if (opts.reasoning_content !== undefined) delta.reasoning_content = opts.reasoning_content;
	return JSON.stringify({
		choices: [{ delta, finish_reason: opts.finish_reason ?? null }],
	});
}

describe('passthrough normalizer', () => {
	it('emits delta.content as text', () => {
		const n = createNormalizer('passthrough');
		const r = n.process(rec(chunk({ content: 'hello' })));
		expect(r.deltas).toEqual([{ type: 'text', text: 'hello' }]);
	});

	it('emits no deltas for empty content', () => {
		const n = createNormalizer('passthrough');
		const r = n.process(rec(chunk({ content: '' })));
		expect(r.deltas).toEqual([]);
	});

	it('signals done on [DONE] sentinel', () => {
		const n = createNormalizer('passthrough');
		expect(n.process(rec('[DONE]')).done).toBe(true);
	});

	it('surfaces finish_reason and usage', () => {
		const n = createNormalizer('passthrough');
		const r = n.process(
			rec(
				JSON.stringify({
					choices: [{ delta: { content: 'x' }, finish_reason: 'stop' }],
					usage: { prompt_tokens: 5, completion_tokens: 2 },
				}),
			),
		);
		expect(r.finishReason).toBe('stop');
		expect(r.usage).toEqual({ promptTokens: 5, completionTokens: 2 });
	});

	it('surfaces llama.cpp timings.predicted_ms as upstreamGenMs', () => {
		const n = createNormalizer('passthrough');
		const r = n.process(
			rec(
				JSON.stringify({
					choices: [],
					usage: { prompt_tokens: 4515, completion_tokens: 209 },
					timings: { predicted_ms: 1361.372, predicted_per_second: 153.52 },
				}),
			),
		);
		expect(r.upstreamGenMs).toBe(1361.372);
	});

	it('leaves upstreamGenMs unset when no timings are present', () => {
		const n = createNormalizer('passthrough');
		const r = n.process(rec(chunk({ content: 'x' })));
		expect(r.upstreamGenMs).toBeUndefined();
	});

	it('ignores a non-positive predicted_ms', () => {
		const n = createNormalizer('passthrough');
		const r = n.process(rec(JSON.stringify({ choices: [], timings: { predicted_ms: 0 } })));
		expect(r.upstreamGenMs).toBeUndefined();
	});

	it('ignores malformed JSON without throwing', () => {
		const n = createNormalizer('passthrough');
		expect(n.process(rec('{not json'))).toEqual({ deltas: [] });
	});
});

describe('openai-o-series normalizer', () => {
	it('emits delta.reasoning_content as reasoning, then delta.content as text', () => {
		const n = createNormalizer('openai-o-series');
		const r = n.process(rec(chunk({ reasoning_content: 'thinking…', content: 'answer' })));
		expect(r.deltas).toEqual([
			{ type: 'reasoning', text: 'thinking…' },
			{ type: 'text', text: 'answer' },
		]);
	});

	it('handles reasoning-only chunks (typical mid-stream)', () => {
		const n = createNormalizer('openai-o-series');
		const r = n.process(rec(chunk({ reasoning_content: 'still thinking' })));
		expect(r.deltas).toEqual([{ type: 'reasoning', text: 'still thinking' }]);
	});

	it('handles content-only chunks (after reasoning ends)', () => {
		const n = createNormalizer('openai-o-series');
		const r = n.process(rec(chunk({ content: 'final answer' })));
		expect(r.deltas).toEqual([{ type: 'text', text: 'final answer' }]);
	});
});

describe('openrouter normalizer', () => {
	it('uses delta.reasoning instead of delta.reasoning_content', () => {
		const n = createNormalizer('openrouter');
		const r = n.process(rec(chunk({ reasoning: 'analyzing', content: 'reply' })));
		expect(r.deltas).toEqual([
			{ type: 'reasoning', text: 'analyzing' },
			{ type: 'text', text: 'reply' },
		]);
	});

	it('does not pick up openai-style reasoning_content', () => {
		const n = createNormalizer('openrouter');
		const r = n.process(rec(chunk({ reasoning_content: 'unused' })));
		expect(r.deltas).toEqual([]);
	});
});

describe('deepseek-r1 normalizer', () => {
	it('inline <think>...</think> is split into reasoning + text', () => {
		const n = createNormalizer('deepseek-r1');
		const r1 = n.process(rec(chunk({ content: '<think>brain</think>hello' })));
		expect(r1.deltas).toEqual([
			{ type: 'reasoning', text: 'brain' },
			{ type: 'text', text: 'hello' },
		]);
	});

	it('handles tag split across chunks', () => {
		const n = createNormalizer('deepseek-r1');
		// The "<th" suffix is a possible-tag-start; should be buffered,
		// not emitted as text.
		const r1 = n.process(rec(chunk({ content: 'before <th' })));
		expect(r1.deltas).toEqual([{ type: 'text', text: 'before ' }]);
		const r2 = n.process(rec(chunk({ content: 'ink>inside</think>after' })));
		expect(r2.deltas).toEqual([
			{ type: 'reasoning', text: 'inside' },
			{ type: 'text', text: 'after' },
		]);
	});

	it('handles closing tag split across chunks', () => {
		const n = createNormalizer('deepseek-r1');
		n.process(rec(chunk({ content: '<think>analyzing' })));
		const r = n.process(rec(chunk({ content: ' more</thi' })));
		// The buffered "</thi" might be the start of </think> — held back.
		expect(r.deltas).toEqual([{ type: 'reasoning', text: ' more' }]);
		const r2 = n.process(rec(chunk({ content: 'nk>done' })));
		expect(r2.deltas).toEqual([{ type: 'text', text: 'done' }]);
	});

	it('flush() releases buffered partial-tag chars at end-of-stream', () => {
		const n = createNormalizer('deepseek-r1');
		// "<thi" looks like start-of-tag; buffered.
		const r = n.process(rec(chunk({ content: 'plain<thi' })));
		expect(r.deltas).toEqual([{ type: 'text', text: 'plain' }]);
		const flushed = n.flush();
		// Stream ended with no closing > — release the held bytes as text.
		expect(flushed.deltas).toEqual([{ type: 'text', text: '<thi' }]);
	});

	it('content with no thinking tag stays as text', () => {
		const n = createNormalizer('deepseek-r1');
		const r = n.process(rec(chunk({ content: 'just regular text' })));
		expect(r.deltas).toEqual([{ type: 'text', text: 'just regular text' }]);
	});

	it('handles content that begins inside a <think> tag', () => {
		const n = createNormalizer('deepseek-r1');
		const r = n.process(rec(chunk({ content: '<think>started reasoning' })));
		expect(r.deltas).toEqual([{ type: 'reasoning', text: 'started reasoning' }]);
	});
});

// --- tool_call delta handling -------------------------------------------
//
// Verifies the OpenAI streaming shape: first chunk for an index carries
// id + function.name (+ optionally some arguments); subsequent chunks
// carry more arguments keyed by index only. Shared across the three
// quirks that route tool_calls through parseToolCallsDelta — exercised
// against all three to pin the contract.

type ToolCallChunk = {
	index: number;
	id?: string;
	type?: 'function';
	function?: { name?: string; arguments?: string };
};

function toolChunk(toolCalls: ToolCallChunk[], opts: { finish_reason?: string } = {}): string {
	return JSON.stringify({
		choices: [
			{
				delta: { tool_calls: toolCalls },
				finish_reason: opts.finish_reason ?? null,
			},
		],
	});
}

describe('passthrough normalizer · tool_calls', () => {
	it('emits tool_call_start the first time an index appears', () => {
		const n = createNormalizer('passthrough');
		const r = n.process(
			rec(
				toolChunk([
					{
						index: 0,
						id: 'call_abc',
						type: 'function',
						function: { name: 'get_current_time', arguments: '' },
					},
				]),
			),
		);
		expect(r.deltas).toEqual([
			{ type: 'tool_call_start', toolCallId: 'call_abc', toolName: 'get_current_time', index: 0 },
		]);
	});

	it('emits start + args delta in the same chunk when args ride along with id', () => {
		const n = createNormalizer('passthrough');
		const r = n.process(
			rec(
				toolChunk([
					{
						index: 0,
						id: 'call_abc',
						type: 'function',
						function: { name: 'get_current_time', arguments: '{"timezone":' },
					},
				]),
			),
		);
		expect(r.deltas).toEqual([
			{ type: 'tool_call_start', toolCallId: 'call_abc', toolName: 'get_current_time', index: 0 },
			{
				type: 'tool_call_args_delta',
				toolCallId: 'call_abc',
				index: 0,
				argumentsDelta: '{"timezone":',
			},
		]);
	});

	it('accumulates arguments across chunks keyed by index', () => {
		const n = createNormalizer('passthrough');
		// Chunk 1: id + name + initial args
		n.process(
			rec(
				toolChunk([
					{
						index: 0,
						id: 'call_abc',
						type: 'function',
						function: { name: 'get_current_time', arguments: '{"' },
					},
				]),
			),
		);
		// Chunk 2: more args, no id/name
		const r2 = n.process(rec(toolChunk([{ index: 0, function: { arguments: 'timezone":"UTC' } }])));
		expect(r2.deltas).toEqual([
			{
				type: 'tool_call_args_delta',
				toolCallId: 'call_abc',
				index: 0,
				argumentsDelta: 'timezone":"UTC',
			},
		]);
		// Chunk 3: closing
		const r3 = n.process(rec(toolChunk([{ index: 0, function: { arguments: '"}' } }])));
		expect(r3.deltas).toEqual([
			{ type: 'tool_call_args_delta', toolCallId: 'call_abc', index: 0, argumentsDelta: '"}' },
		]);
	});

	it('handles parallel tool calls with different indexes', () => {
		const n = createNormalizer('passthrough');
		// Both starts in one chunk.
		const r = n.process(
			rec(
				toolChunk([
					{
						index: 0,
						id: 'call_one',
						type: 'function',
						function: { name: 'get_current_time', arguments: '' },
					},
					{
						index: 1,
						id: 'call_two',
						type: 'function',
						function: { name: 'get_current_time', arguments: '' },
					},
				]),
			),
		);
		expect(r.deltas).toEqual([
			{ type: 'tool_call_start', toolCallId: 'call_one', toolName: 'get_current_time', index: 0 },
			{ type: 'tool_call_start', toolCallId: 'call_two', toolName: 'get_current_time', index: 1 },
		]);
		// Args for call_two arrive while call_one is mid-stream — must
		// route to the right id by index.
		const r2 = n.process(
			rec(
				toolChunk([
					{ index: 0, function: { arguments: 'A' } },
					{ index: 1, function: { arguments: 'B' } },
				]),
			),
		);
		expect(r2.deltas).toEqual([
			{ type: 'tool_call_args_delta', toolCallId: 'call_one', index: 0, argumentsDelta: 'A' },
			{ type: 'tool_call_args_delta', toolCallId: 'call_two', index: 1, argumentsDelta: 'B' },
		]);
	});

	it('drops args-only chunks for an index that has not been started (defensive)', () => {
		const n = createNormalizer('passthrough');
		// Spec-violating: args without a prior id+name. Should be dropped, not throw.
		const r = n.process(rec(toolChunk([{ index: 0, function: { arguments: 'orphan' } }])));
		expect(r.deltas).toEqual([]);
	});

	it('drops empty argument deltas', () => {
		const n = createNormalizer('passthrough');
		n.process(
			rec(
				toolChunk([
					{
						index: 0,
						id: 'call_x',
						type: 'function',
						function: { name: 't', arguments: '' },
					},
				]),
			),
		);
		// Second chunk with arguments: "" — should not emit a delta event.
		const r = n.process(rec(toolChunk([{ index: 0, function: { arguments: '' } }])));
		expect(r.deltas).toEqual([]);
	});

	it('interleaves text and tool_call deltas from a single chunk', () => {
		// OpenAI permits both content and tool_calls in the same delta.
		const n = createNormalizer('passthrough');
		const r = n.process(
			rec(
				JSON.stringify({
					choices: [
						{
							delta: {
								content: 'let me check ',
								tool_calls: [
									{
										index: 0,
										id: 'call_q',
										type: 'function',
										function: { name: 'get_current_time' },
									},
								],
							},
							finish_reason: null,
						},
					],
				}),
			),
		);
		expect(r.deltas).toEqual([
			{ type: 'text', text: 'let me check ' },
			{ type: 'tool_call_start', toolCallId: 'call_q', toolName: 'get_current_time', index: 0 },
		]);
	});

	it('surfaces finish_reason=tool_calls', () => {
		const n = createNormalizer('passthrough');
		const r = n.process(rec(toolChunk([], { finish_reason: 'tool_calls' })));
		expect(r.finishReason).toBe('tool_calls');
	});
});

describe('openai-o-series normalizer · tool_calls', () => {
	it('emits tool_call deltas alongside the existing reasoning/text handling', () => {
		const n = createNormalizer('openai-o-series');
		const r = n.process(
			rec(
				JSON.stringify({
					choices: [
						{
							delta: {
								reasoning_content: 'thinking...',
								tool_calls: [
									{
										index: 0,
										id: 'call_o',
										type: 'function',
										function: { name: 'get_current_time' },
									},
								],
							},
							finish_reason: null,
						},
					],
				}),
			),
		);
		expect(r.deltas).toEqual([
			{ type: 'reasoning', text: 'thinking...' },
			{ type: 'tool_call_start', toolCallId: 'call_o', toolName: 'get_current_time', index: 0 },
		]);
	});
});

describe('openrouter normalizer · tool_calls', () => {
	it('emits tool_call deltas alongside the existing reasoning/text handling', () => {
		const n = createNormalizer('openrouter');
		const r = n.process(
			rec(
				JSON.stringify({
					choices: [
						{
							delta: {
								reasoning: 'thinking...',
								tool_calls: [
									{
										index: 0,
										id: 'call_r',
										type: 'function',
										function: { name: 'get_current_time' },
									},
								],
							},
							finish_reason: null,
						},
					],
				}),
			),
		);
		expect(r.deltas).toEqual([
			{ type: 'reasoning', text: 'thinking...' },
			{ type: 'tool_call_start', toolCallId: 'call_r', toolName: 'get_current_time', index: 0 },
		]);
	});
});
