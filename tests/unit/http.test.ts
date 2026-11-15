/** Tests for the server-side request-body parser. */

import { describe, expect, it } from 'vitest';
import {
	isBodyTooLarge,
	optionalString,
	parseFormData,
	parseJsonBody,
	requireMaxItems,
	requireMaxLength,
} from '#lib/server/http.js';

function jsonRequest(body: string): Request {
	return new Request('http://localhost/api/x', { method: 'POST', body });
}

/** Kit's body-limit rejection: an unexported SvelteKitError carrying the status. */
function kitBodyLimitError(message = 'Content-length of 5105 exceeds limit of 1024 bytes.') {
	return Object.assign(new Error(message), { name: 'SvelteKitError', status: 413 });
}

function failingRequest(method: 'json' | 'formData', err: Error): Request {
	return { [method]: () => Promise.reject(err) } as unknown as Request;
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

	it('throws 413 when the body exceeded BODY_SIZE_LIMIT', async () => {
		await expect(parseJsonBody(failingRequest('json', kitBodyLimitError()))).rejects.toMatchObject({
			status: 413,
			body: { message: expect.stringMatching(/BODY_SIZE_LIMIT/) as unknown },
		});
	});
});

describe('isBodyTooLarge', () => {
	it.each([
		'Content-length of 5105 exceeds limit of 1024 bytes.',
		'request body size exceeded BODY_SIZE_LIMIT of 1024',
		'request body size exceeded content-length of 5105',
	])("recognises Kit's 413 rejection (%s)", (msg) => {
		expect(isBodyTooLarge(kitBodyLimitError(msg))).toBe(true);
	});

	it('goes by the status, not the wording', () => {
		expect(isBodyTooLarge(new Error('Content-length of 5105 exceeds limit of 1024 bytes.'))).toBe(
			false,
		);
		expect(isBodyTooLarge(null)).toBe(false);
		expect(isBodyTooLarge('413')).toBe(false);
	});
});

describe('parseFormData', () => {
	it('returns the parsed form', async () => {
		const fd = new FormData();
		fd.set('a', 'b');
		const req = new Request('http://localhost/api/x', { method: 'POST', body: fd });
		expect((await parseFormData(req, 'bad')).get('a')).toBe('b');
	});

	it('throws 413 naming BODY_SIZE_LIMIT when the body exceeded it', async () => {
		await expect(
			parseFormData(failingRequest('formData', kitBodyLimitError()), 'bad'),
		).rejects.toMatchObject({
			status: 413,
			body: { message: expect.stringMatching(/BODY_SIZE_LIMIT/) as unknown },
		});
	});

	it("throws 400 with the caller's message for any other failure", async () => {
		await expect(
			parseFormData(failingRequest('formData', new TypeError('bad boundary')), 'Not multipart'),
		).rejects.toMatchObject({ status: 400, body: { message: 'Not multipart' } });
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

describe('requireMaxLength / requireMaxItems', () => {
	it('passes values at the ceiling through, and refuses past it', () => {
		expect(requireMaxLength('abc', 'f', 3)).toBe('abc');
		expect(requireMaxLength(undefined, 'f', 3)).toBeUndefined();
		expect(() => requireMaxLength('abcd', 'f', 3)).toThrow(
			expect.objectContaining({ status: 400 }),
		);
		expect(requireMaxItems([1, 2], 'f', 2)).toEqual([1, 2]);
		expect(() => requireMaxItems([1, 2, 3], 'f', 2)).toThrow(
			expect.objectContaining({ status: 400 }),
		);
	});
});
