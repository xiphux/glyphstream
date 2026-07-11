import { describe, expect, it } from 'vitest';
import {
	extractUpstreamErrorMessage,
	formatUpstreamError,
	isPermanentRequestError,
	parseContextOverflow,
	UpstreamError,
} from '$lib/server/endpoints/client';

describe('extractUpstreamErrorMessage', () => {
	it('returns null for empty body', () => {
		expect(extractUpstreamErrorMessage(null)).toBeNull();
		expect(extractUpstreamErrorMessage('')).toBeNull();
		expect(extractUpstreamErrorMessage('   ')).toBeNull();
	});

	it('extracts the OpenAI {error: {message}} shape', () => {
		const body = JSON.stringify({
			error: {
				code: 500,
				message: 'image input is not supported - hint: provide the mmproj',
				type: 'server_error',
			},
		});
		expect(extractUpstreamErrorMessage(body)).toBe(
			'image input is not supported - hint: provide the mmproj',
		);
	});

	it('extracts the simpler {error: "string"} shape', () => {
		const body = JSON.stringify({ error: 'something went wrong' });
		expect(extractUpstreamErrorMessage(body)).toBe('something went wrong');
	});

	it('falls back to top-level {message: "..."}', () => {
		const body = JSON.stringify({ message: 'rate limit exceeded' });
		expect(extractUpstreamErrorMessage(body)).toBe('rate limit exceeded');
	});

	it('returns the raw body when JSON has no recognizable error fields', () => {
		const body = JSON.stringify({ status: 'fail', code: 42 });
		expect(extractUpstreamErrorMessage(body)).toBe(body);
	});

	it('returns plain-text bodies as-is', () => {
		expect(extractUpstreamErrorMessage('Internal Server Error')).toBe('Internal Server Error');
	});

	it('truncates very long bodies so the user banner stays readable', () => {
		const long = 'a'.repeat(1000);
		const out = extractUpstreamErrorMessage(long);
		expect(out?.length).toBeLessThanOrEqual(401);
		expect(out?.endsWith('…')).toBe(true);
	});

	it('trims whitespace around the extracted message', () => {
		const body = JSON.stringify({ error: { message: '  spaced out  ' } });
		expect(extractUpstreamErrorMessage(body)).toBe('spaced out');
	});

	it('ignores empty error.message', () => {
		const body = JSON.stringify({ error: { message: '   ' } });
		expect(extractUpstreamErrorMessage(body)).toBeNull();
	});
});

describe('formatUpstreamError', () => {
	it('appends the upstream message when present', () => {
		const e = new UpstreamError(
			'Endpoint "llama" returned HTTP 500 from /chat/completions (stream)',
			500,
			JSON.stringify({
				error: {
					code: 500,
					message: 'image input is not supported - hint: provide the mmproj',
				},
			}),
		);
		expect(formatUpstreamError(e)).toBe(
			'Endpoint "llama" returned HTTP 500 from /chat/completions (stream): image input is not supported - hint: provide the mmproj',
		);
	});

	it('falls back to the templated message when body is empty', () => {
		const e = new UpstreamError(
			'Network error contacting endpoint "x" at http://…: ECONNREFUSED',
			null,
			null,
		);
		expect(formatUpstreamError(e)).toBe(
			'Network error contacting endpoint "x" at http://…: ECONNREFUSED',
		);
	});
});

describe('isPermanentRequestError', () => {
	const err = (status: number | null) => new UpstreamError('x', status, null);

	it('is true for a 4xx the endpoint refused on the request (400 context overflow)', () => {
		expect(isPermanentRequestError(err(400))).toBe(true);
		expect(isPermanentRequestError(err(413))).toBe(true); // payload too large
		expect(isPermanentRequestError(err(422))).toBe(true); // unprocessable
		expect(isPermanentRequestError(err(404))).toBe(true);
	});

	it('is false for transient 4xx (timeout / rate limit) that may clear on retry', () => {
		expect(isPermanentRequestError(err(408))).toBe(false);
		expect(isPermanentRequestError(err(429))).toBe(false);
	});

	it('is false for systemic auth-class 4xx (they fail every request, not just this one)', () => {
		expect(isPermanentRequestError(err(401))).toBe(false);
		expect(isPermanentRequestError(err(403))).toBe(false);
		expect(isPermanentRequestError(err(407))).toBe(false);
	});

	it('is false for 5xx / null-status (network) — endpoint-level, not per-request', () => {
		expect(isPermanentRequestError(err(500))).toBe(false);
		expect(isPermanentRequestError(err(503))).toBe(false);
		expect(isPermanentRequestError(err(null))).toBe(false);
	});

	it('is false for non-UpstreamError values', () => {
		expect(isPermanentRequestError(new Error('boom'))).toBe(false);
		expect(isPermanentRequestError(null)).toBe(false);
		expect(isPermanentRequestError({ status: 400 })).toBe(false);
	});
});

describe('parseContextOverflow', () => {
	const err = (body: unknown, status = 400) =>
		new UpstreamError('HTTP 400', status, JSON.stringify(body));

	it("recovers llama.cpp's reported prompt size and real context window", () => {
		// Verbatim shape from the production failure.
		const e = err({
			error: {
				code: 400,
				message:
					'request (104317 tokens) exceeds the available context size (98304 tokens), try increasing it',
				type: 'exceed_context_size_error',
				n_prompt_tokens: 104317,
				n_ctx: 98304,
			},
		});
		expect(parseContextOverflow(e)).toEqual({ promptTokens: 104317, contextWindow: 98304 });
	});

	it('recognizes the OpenAI-style overflow, which carries no numbers', () => {
		const byCode = err({ error: { code: 'context_length_exceeded', message: 'too long' } });
		expect(parseContextOverflow(byCode)).toEqual({ promptTokens: 0, contextWindow: 0 });

		const byMessage = err({
			error: {
				message: "This model's maximum context length is 8192 tokens",
				type: 'invalid_request_error',
			},
		});
		expect(parseContextOverflow(byMessage)).toEqual({ promptTokens: 0, contextWindow: 0 });
	});

	it('is null for a 4xx that is not an overflow — a bad request must still fail', () => {
		expect(parseContextOverflow(err({ error: { message: 'unknown parameter: foo' } }))).toBeNull();
		expect(parseContextOverflow(err({ error: { message: 'context' } }))).toBeNull(); // bare word, no size/length/window
	});

	it('is null for 5xx, missing/unparseable bodies, and non-UpstreamError values', () => {
		expect(
			parseContextOverflow(err({ error: { type: 'exceed_context_size_error' } }, 500)),
		).toBeNull();
		expect(parseContextOverflow(new UpstreamError('HTTP 400', 400, null))).toBeNull();
		expect(parseContextOverflow(new UpstreamError('HTTP 400', 400, 'not json'))).toBeNull();
		expect(parseContextOverflow(new Error('boom'))).toBeNull();
	});

	it('ignores nonsense token counts rather than trusting them into a bad budget', () => {
		const e = err({
			error: { type: 'exceed_context_size_error', n_prompt_tokens: -1, n_ctx: 'lots' },
		});
		expect(parseContextOverflow(e)).toEqual({ promptTokens: 0, contextWindow: 0 });
	});
});
