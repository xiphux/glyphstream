/** Tests for the model-id grammar and the model-kind guard. */

import { describe, expect, it } from 'vitest';
import { formatModelId, parseModelId } from '$lib/server/endpoints/model-id';
import { endpointIdOf, mediaSourceModelId } from '$lib/model-ids';
import { isModelKind, MODEL_KINDS } from '$lib/types/api';

describe('parseModelId', () => {
	it('splits a well-formed id on the :: separator', () => {
		expect(parseModelId('groq::llama-3.1-70b')).toEqual({
			endpointId: 'groq',
			upstreamId: 'llama-3.1-70b',
		});
	});

	it('splits on the first :: so a separator inside the upstream id survives', () => {
		expect(parseModelId('bridge::weird::name')).toEqual({
			endpointId: 'bridge',
			upstreamId: 'weird::name',
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

describe('endpointIdOf', () => {
	it('matches parseModelId on the endpoint half, including its null cases', () => {
		for (const id of ['groq::llama', 'bridge::weird::name', 'plain-id', '::model', 'endpoint::']) {
			expect(endpointIdOf(id)).toBe(parseModelId(id)?.endpointId ?? null);
		}
	});
});

/**
 * The shape assertions here are pinned to what the DB actually holds: every
 * generated row writes `sourceModel` from the relay's `storedModelId`, which is
 * the whole internal id, NOT the upstream half. The launch intent used to
 * re-join it to `sourceEndpointId` and seed the picker with `bridge::bridge::x`,
 * which resolves to nothing — so "Regenerate with this prompt" silently landed
 * on the default (chat) model. The old test fixtures said `flux-dev`, a shape
 * production never writes, which is why nothing caught it.
 */
describe('mediaSourceModelId', () => {
	it('passes through a sourceModel that already carries its endpoint prefix', () => {
		expect(mediaSourceModelId('bridge', 'bridge::comfyui/flux-2-klein')).toBe(
			'bridge::comfyui/flux-2-klein',
		);
	});

	it('composes when sourceModel is a bare upstream id', () => {
		expect(mediaSourceModelId('bridge', 'comfyui/sdxl')).toBe('bridge::comfyui/sdxl');
	});

	it('composes rather than pattern-matching when the prefix is a different endpoint', () => {
		// An upstream id containing `::` is not an endpoint prefix.
		expect(mediaSourceModelId('bridge', 'weird::name')).toBe('bridge::weird::name');
	});

	it('keeps a prefixed id when no endpoint was recorded', () => {
		expect(mediaSourceModelId(null, 'bridge::sdxl')).toBe('bridge::sdxl');
	});

	it('is null when nothing resolvable is recorded', () => {
		expect(mediaSourceModelId(null, null)).toBeNull();
		expect(mediaSourceModelId('bridge', null)).toBeNull();
		// `run_python` outputs: generated, but by no endpoint and no model.
		expect(mediaSourceModelId(null, 'run_python')).toBeNull();
	});
});
