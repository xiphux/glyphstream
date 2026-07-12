import { describe, expect, it } from 'vitest';
import { UpstreamError } from '$lib/server/endpoints/client';
import {
	approxTokens,
	capAtBoundary,
	memoryInputBudget,
	shrinkBudgetAfterOverflow,
	splitToBudget,
} from '$lib/server/memory/summarize-util';

const OPTS = { maxTokens: 500, overheadTokens: 400, minBudget: 1000 };

/** llama.cpp's context-overflow 400. */
const overflow = (promptTokens: number, nCtx: number) =>
	new UpstreamError(
		'Endpoint "llama" returned HTTP 400',
		400,
		JSON.stringify({
			error: {
				code: 400,
				message: `request (${promptTokens} tokens) exceeds the available context size (${nCtx} tokens)`,
				type: 'exceed_context_size_error',
				n_prompt_tokens: promptTokens,
				n_ctx: nCtx,
			},
		}),
	);

describe('shrinkBudgetAfterOverflow', () => {
	it('lands the next budget under the window the upstream actually reported', () => {
		// The production case: we budgeted against an advertised 131072 window; llama
		// says the real one is 98304 and that we sent 104317 tokens.
		const budget = memoryInputBudget(131072, OPTS.maxTokens, OPTS.overheadTokens, OPTS.minBudget);
		const next = shrinkBudgetAfterOverflow(overflow(104317, 98304), budget, OPTS)!;

		expect(next).toBeLessThan(budget);
		// The real usable input space, by the upstream's own numbers. The corrected
		// budget must fit inside it even if chars/4 keeps undercounting a little.
		expect(next).toBeLessThan(98304 - OPTS.maxTokens - OPTS.overheadTokens);
	});

	it('corrects for a tokenizer undercount, not just a wrong window', () => {
		// Same window we budgeted against (no config error) — but the payload we
		// estimated at `budget` really weighed 1.5x that. The scale factor has to come
		// from the ratio, not the window.
		const budget = memoryInputBudget(98304, OPTS.maxTokens, OPTS.overheadTokens, OPTS.minBudget);
		const next = shrinkBudgetAfterOverflow(
			overflow(Math.round(budget * 1.5), 98304),
			budget,
			OPTS,
		)!;
		expect(next).toBeLessThanOrEqual(Math.floor(budget * 0.6));
	});

	it('uses a reported n_ctx even when the vendor omits the prompt count', () => {
		// Regression: the window is the one bound we were actually handed. Deriving the
		// next budget ONLY from the prompt-count ratio discarded it, leaving a vendor
		// that reports n_ctx but not n_prompt_tokens to grind through flat 0.6x shrinks
		// — and possibly give up — despite having been told exactly what fits.
		const e = new UpstreamError(
			'HTTP 400',
			400,
			JSON.stringify({
				error: { type: 'exceed_context_size_error', message: 'too long', n_ctx: 8192 },
			}),
		);
		const allowed = memoryInputBudget(8192, OPTS.maxTokens, OPTS.overheadTokens, 0);
		const next = shrinkBudgetAfterOverflow(e, 100_000, OPTS)!;

		expect(next).toBeLessThanOrEqual(allowed); // one step, straight under the real window
		expect(next).toBeLessThan(Math.floor(100_000 * 0.6)); // not merely the flat shrink
	});

	it('still shrinks when the vendor names the overflow but reports no numbers', () => {
		const e = new UpstreamError(
			'HTTP 400',
			400,
			JSON.stringify({ error: { code: 'context_length_exceeded', message: 'too long' } }),
		);
		expect(shrinkBudgetAfterOverflow(e, 10_000, OPTS)).toBe(6000); // flat factor
	});

	it('returns null for an error that is not an overflow (rethrow, do not retry)', () => {
		const notOverflow = new UpstreamError('HTTP 400', 400, '{"error":{"message":"bad param"}}');
		expect(shrinkBudgetAfterOverflow(notOverflow, 10_000, OPTS)).toBeNull();
		expect(shrinkBudgetAfterOverflow(new Error('boom'), 10_000, OPTS)).toBeNull();
	});

	it('returns null once it is already at the floor — nothing left to give', () => {
		expect(shrinkBudgetAfterOverflow(overflow(50_000, 8000), OPTS.minBudget, OPTS)).toBeNull();
	});
});

describe('splitToBudget', () => {
	it('leaves a string that already fits alone', () => {
		expect(splitToBudget('short', 1000)).toEqual(['short']);
	});

	it('splits an oversized string into pieces that each fit', () => {
		const s = 'word '.repeat(4000); // 20k chars ≈ 5000 tokens
		const pieces = splitToBudget(s, 1000);
		expect(pieces.length).toBeGreaterThan(1);
		for (const p of pieces) expect(approxTokens(p)).toBeLessThanOrEqual(1000);
		// Lossless: every word survives the split.
		expect(pieces.join(' ').split(/\s+/).filter(Boolean)).toHaveLength(4000);
	});

	it('still terminates on an unbroken blob with no whitespace to break at', () => {
		const pieces = splitToBudget('x'.repeat(20_000), 1000);
		expect(pieces.length).toBeGreaterThan(1);
		for (const p of pieces) expect(approxTokens(p)).toBeLessThanOrEqual(1000);
		expect(pieces.join('')).toHaveLength(20_000);
	});
});

describe('capAtBoundary', () => {
	it('leaves text within the cap untouched', () => {
		expect(capAtBoundary('Already short.', 100)).toBe('Already short.');
	});

	it('cuts a structured map at the last COMPLETE line', () => {
		const map = ['## Infra', '- docker deploys', '- sqlite tuning', '- a truncated tail'].join(
			'\n',
		);
		const out = capAtBoundary(map, map.length - 5);
		expect(out).toBe('## Infra\n- docker deploys\n- sqlite tuning…');
		expect(out).not.toContain('truncated');
	});

	it('cuts prose at a sentence end rather than mid-sentence', () => {
		const s = 'First sentence here. Second one follows. And a third that gets cut off midway.';
		const out = capAtBoundary(s, 60);
		expect(out).toBe('First sentence here. Second one follows.…');
	});

	it('falls back to a word break when there is no sentence or line boundary', () => {
		const out = capAtBoundary('alpha bravo charlie delta echo foxtrot', 20);
		expect(out).toBe('alpha bravo charlie…');
		expect(out.length).toBeLessThanOrEqual(20);
	});

	it('returns the text intact rather than an ellipsis when the cap is nonsense', () => {
		// A missing/zero cap is a config or wiring bug. Reducing the whole map to "…"
		// would destroy the content AND hide the bug.
		expect(capAtBoundary('some real content', undefined as unknown as number)).toBe(
			'some real content',
		);
		expect(capAtBoundary('some real content', 0)).toBe('some real content');
	});

	it('never exceeds the cap, and never ends mid-word', () => {
		const s = 'lorem ipsum dolor sit amet '.repeat(50);
		for (const max of [10, 37, 100, 601]) {
			const out = capAtBoundary(s, max);
			expect(out.length).toBeLessThanOrEqual(max);
			expect(out.endsWith('…')).toBe(true);
			expect(out.slice(0, -1)).not.toMatch(/\S{0,}\bdolo$|ipsu$|lore$/); // no chopped words
		}
	});
});
