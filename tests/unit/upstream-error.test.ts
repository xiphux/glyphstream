import { describe, expect, it } from 'vitest';
import {
	extractUpstreamErrorMessage,
	formatUpstreamError,
	UpstreamError
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
				type: 'server_error'
			}
		});
		expect(extractUpstreamErrorMessage(body)).toBe(
			'image input is not supported - hint: provide the mmproj'
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
					message: 'image input is not supported - hint: provide the mmproj'
				}
			})
		);
		expect(formatUpstreamError(e)).toBe(
			'Endpoint "llama" returned HTTP 500 from /chat/completions (stream): image input is not supported - hint: provide the mmproj'
		);
	});

	it('falls back to the templated message when body is empty', () => {
		const e = new UpstreamError(
			'Network error contacting endpoint "x" at http://…: ECONNREFUSED',
			null,
			null
		);
		expect(formatUpstreamError(e)).toBe(
			'Network error contacting endpoint "x" at http://…: ECONNREFUSED'
		);
	});
});
