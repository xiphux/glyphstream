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
		choices: [{ delta, finish_reason: opts.finish_reason ?? null }]
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
					usage: { prompt_tokens: 5, completion_tokens: 2 }
				})
			)
		);
		expect(r.finishReason).toBe('stop');
		expect(r.usage).toEqual({ promptTokens: 5, completionTokens: 2 });
	});

	it('ignores malformed JSON without throwing', () => {
		const n = createNormalizer('passthrough');
		expect(n.process(rec('{not json'))).toEqual({ deltas: [] });
	});
});

describe('openai-o-series normalizer', () => {
	it('emits delta.reasoning_content as reasoning, then delta.content as text', () => {
		const n = createNormalizer('openai-o-series');
		const r = n.process(
			rec(chunk({ reasoning_content: 'thinking…', content: 'answer' }))
		);
		expect(r.deltas).toEqual([
			{ type: 'reasoning', text: 'thinking…' },
			{ type: 'text', text: 'answer' }
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
			{ type: 'text', text: 'reply' }
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
			{ type: 'text', text: 'hello' }
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
			{ type: 'text', text: 'after' }
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
