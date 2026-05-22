/** Tests for the model-id grammar and the model-kind guard. */

import { describe, expect, it } from 'vitest';
import { formatModelId, parseModelId } from '$lib/server/endpoints/model-id';
import { isModelKind, MODEL_KINDS } from '$lib/types/api';

describe('parseModelId', () => {
	it('splits a well-formed id on the :: separator', () => {
		expect(parseModelId('groq::llama-3.1-70b')).toEqual({
			endpointId: 'groq',
			upstreamId: 'llama-3.1-70b'
		});
	});

	it('splits on the first :: so a separator inside the upstream id survives', () => {
		expect(parseModelId('bridge::weird::name')).toEqual({
			endpointId: 'bridge',
			upstreamId: 'weird::name'
		});
	});

	it('returns null when there is no separator', () => {
		expect(parseModelId('plain-id')).toBeNull();
	});

	it('returns null for an empty endpoint id', () => {
		expect(parseModelId('::model')).toBeNull();
	});

	it('returns null for an empty upstream id', () => {
		expect(parseModelId('endpoint::')).toBeNull();
	});

	it('round-trips with formatModelId', () => {
		expect(parseModelId(formatModelId('e', 'm'))).toEqual({ endpointId: 'e', upstreamId: 'm' });
	});
});

describe('isModelKind', () => {
	it('accepts every declared model kind', () => {
		for (const k of MODEL_KINDS) expect(isModelKind(k)).toBe(true);
	});

	it('rejects unknown strings and non-strings', () => {
		expect(isModelKind('audio')).toBe(false);
		expect(isModelKind('')).toBe(false);
		expect(isModelKind(undefined)).toBe(false);
		expect(isModelKind(null)).toBe(false);
		expect(isModelKind(3)).toBe(false);
	});
});
