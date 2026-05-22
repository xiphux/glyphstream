/** Tests for the client-side fetch-error message extractor. */

import { describe, expect, it } from 'vitest';
import { errorMessageFromResponse } from '$lib/fetch-error';

describe('errorMessageFromResponse', () => {
	it('returns the JSON body message when present', async () => {
		const res = new Response(JSON.stringify({ message: 'too many requests' }), { status: 429 });
		expect(await errorMessageFromResponse(res)).toBe('too many requests');
	});

	it('falls back to HTTP <status> for an empty message', async () => {
		const res = new Response(JSON.stringify({ message: '' }), { status: 400 });
		expect(await errorMessageFromResponse(res)).toBe('HTTP 400');
	});

	it('falls back when the JSON body has no message field', async () => {
		const res = new Response(JSON.stringify({ error: 'x' }), { status: 400 });
		expect(await errorMessageFromResponse(res)).toBe('HTTP 400');
	});

	it('falls back for a non-JSON body', async () => {
		const res = new Response('Internal Server Error', { status: 500 });
		expect(await errorMessageFromResponse(res)).toBe('HTTP 500');
	});
});
