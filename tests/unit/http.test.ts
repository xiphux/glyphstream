/** Tests for the server-side request-body parser. */

import { describe, expect, it } from 'vitest';
import { optionalString, parseJsonBody } from '#lib/server/http.js';

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

describe('optionalString', () => {
	it('passes a string through untouched', () => {
		expect(optionalString('  hi ', 'title')).toBe('  hi ');
	});

	it('maps absent values to undefined', () => {
		expect(optionalString(undefined, 'title')).toBeUndefined();
		expect(optionalString(null, 'title')).toBeUndefined();
	});

	it.each([5, true, {}, ['a']])('throws a 400 naming the field for %j', (v) => {
		let caught: unknown;
		try {
			optionalString(v, 'title');
		} catch (e) {
			caught = e;
		}
		expect(caught).toMatchObject({ status: 400, body: { message: "'title' must be a string" } });
	});
});
