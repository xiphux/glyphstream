/** Tests for the JSON text-column parsers. */

import { describe, expect, it } from 'vitest';
import { parseMessageParts, parseModelParameters } from '$lib/server/db/queries/json-columns';

describe('parseMessageParts', () => {
	it('parses a valid MessagePart array', () => {
		const raw = JSON.stringify([{ type: 'text', text: 'hi' }]);
		expect(parseMessageParts(raw)).toEqual([{ type: 'text', text: 'hi' }]);
	});

	it('returns [] for malformed JSON', () => {
		expect(parseMessageParts('{not json')).toEqual([]);
	});

	it('returns [] for a non-array payload', () => {
		expect(parseMessageParts(JSON.stringify({ type: 'text' }))).toEqual([]);
		expect(parseMessageParts('null')).toEqual([]);
	});
});

describe('parseModelParameters', () => {
	it('parses a valid parameters object', () => {
		expect(parseModelParameters(JSON.stringify({ temperature: 0.7 }))).toEqual({
			temperature: 0.7
		});
	});

	it('returns null for a null or empty column', () => {
		expect(parseModelParameters(null)).toBeNull();
		expect(parseModelParameters('')).toBeNull();
	});

	it('returns null for malformed JSON', () => {
		expect(parseModelParameters('{bad')).toBeNull();
	});
});
