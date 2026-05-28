/** Tests for the JSON text-column parsers. */

import { describe, expect, it } from 'vitest';
import {
	parseDisabledFeatures,
	parseMessageParts,
	parseModelParameters
} from '$lib/server/db/queries/json-columns';

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

describe('parseDisabledFeatures', () => {
	it('parses a valid FeatureCategory array', () => {
		expect(parseDisabledFeatures(JSON.stringify(['web']))).toEqual(['web']);
	});

	it('returns [] for null / empty column', () => {
		expect(parseDisabledFeatures(null)).toEqual([]);
		expect(parseDisabledFeatures('')).toEqual([]);
	});

	it('returns [] for malformed JSON', () => {
		expect(parseDisabledFeatures('{not json')).toEqual([]);
	});

	it('returns [] for a non-array payload', () => {
		expect(parseDisabledFeatures(JSON.stringify({ web: true }))).toEqual([]);
		expect(parseDisabledFeatures('null')).toEqual([]);
		expect(parseDisabledFeatures('"web"')).toEqual([]);
	});

	it('silently drops unknown category strings (lenient on read)', () => {
		// Deliberately asymmetric with validateDisabledFeatures (which throws):
		// a stale category left over from a code change should turn into
		// "feature on" rather than break the conversation. The API-side
		// validator is the place to be strict.
		expect(parseDisabledFeatures(JSON.stringify(['web', 'memory', 'totally-bogus']))).toEqual([
			'web'
		]);
	});

	it('silently drops non-string entries', () => {
		expect(parseDisabledFeatures(JSON.stringify(['web', 42, null, {}]))).toEqual(['web']);
	});
});
