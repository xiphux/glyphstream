/** Tests for the server-side request-body parser. */

import { describe, expect, it } from 'vitest';
import { parseJsonBody } from '$lib/server/http';

function jsonRequest(body: string): Request {
	return new Request('http://localhost/api/x', { method: 'POST', body });
}

describe('parseJsonBody', () => {
	it('parses a JSON object body', async () => {
		expect(await parseJsonBody(jsonRequest('{"a":1}'))).toEqual({ a: 1 });
	});

	it('throws 400 for malformed JSON', async () => {
		await expect(parseJsonBody(jsonRequest('{bad'))).rejects.toMatchObject({ status: 400 });
	});

	it('throws 400 for a null body', async () => {
		await expect(parseJsonBody(jsonRequest('null'))).rejects.toMatchObject({ status: 400 });
	});

	it('throws 400 for a scalar body', async () => {
		await expect(parseJsonBody(jsonRequest('42'))).rejects.toMatchObject({ status: 400 });
	});
});
