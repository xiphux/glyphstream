/** Tests for the JSON text-column parsers. */

import { describe, expect, it } from 'vitest';
import {
	parseDisabledFeatures,
	parseMessageParts,
	parseModelParameters,
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
			temperature: 0.7,
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

	it('preserves arbitrary non-empty strings (including MCP categories like mcp:foo)', () => {
		// FeatureCategory was widened so dynamically-discovered MCP servers
		// can contribute `mcp:<server-id>` opt-out categories. Round-tripping
		// must preserve a user's choice even when the backing server isn't
		// currently registered (e.g. a transient config edit) — otherwise the
		// next save would wipe the preference. Conversation-create silently
		// filters categories that aren't currently registered when seeding
		// from a custom model's defaults.
		expect(parseDisabledFeatures(JSON.stringify(['web', 'mcp:filesystem', 'mcp:linear']))).toEqual([
			'web',
			'mcp:filesystem',
			'mcp:linear',
		]);
	});

	it('silently drops non-string entries', () => {
		expect(parseDisabledFeatures(JSON.stringify(['web', 42, null, {}]))).toEqual(['web']);
	});
});
