/**
 * Unit tests for the fan-out dispatch guards extracted from the messages route.
 * The invariant that's otherwise awkward to reach through the full handler:
 *  - resolveModelOverride: a fan-out branch's model is TRANSIENT — it must never
 *    be persisted (persist:false), or N concurrent branches clobber the
 *    conversation's stored default. This is the regression guard the plan called
 *    a linchpin ("silently rewrites users' conversation models").
 */
import { describe, it, expect } from 'vitest';
import {
	resolveBranchIndex,
	resolveModelOverride,
	ModelOverrideError,
} from '$lib/server/messages/fanout-dispatch';

const resolvers = {
	parseEndpointId: (id: string) => (id.includes('::') ? id.split('::')[0] : null),
	endpointExists: (id: string) => id === 'bridge',
};

describe('resolveModelOverride', () => {
	it('a fan-out branch never persists the override (the transient-model linchpin)', () => {
		const res = resolveModelOverride({
			bodyModelId: 'bridge::flux',
			bodyModelKind: 'image',
			currentModelId: 'bridge::sdxl',
			currentModelKind: 'image',
			isFanout: true,
			...resolvers,
		});
		expect(res.override).toEqual({
			endpointId: 'bridge',
			modelId: 'bridge::flux',
			modelKind: 'image',
		});
		expect(res.persist).toBe(false); // <- must not rewrite the conversation row
	});

	it('a normal send DOES persist the override', () => {
		const res = resolveModelOverride({
			bodyModelId: 'bridge::flux',
			bodyModelKind: 'image',
			currentModelId: 'bridge::sdxl',
			currentModelKind: 'image',
			isFanout: false,
			...resolvers,
		});
		expect(res.persist).toBe(true);
	});

	it('no override when the body model is absent, empty, or unchanged', () => {
		for (const bodyModelId of [undefined, '', 'bridge::sdxl']) {
			const res = resolveModelOverride({
				bodyModelId,
				bodyModelKind: 'image',
				currentModelId: 'bridge::sdxl',
				currentModelKind: 'image',
				isFanout: false,
				...resolvers,
			});
			expect(res.override).toBeNull();
			expect(res.persist).toBe(false);
		}
	});

	it('falls back to the current kind when the body kind is invalid', () => {
		const res = resolveModelOverride({
			bodyModelId: 'bridge::flux',
			bodyModelKind: 'not-a-kind',
			currentModelId: 'bridge::sdxl',
			currentModelKind: 'video',
			isFanout: false,
			...resolvers,
		});
		expect(res.override?.modelKind).toBe('video');
	});

	it('throws on a malformed model id', () => {
		expect(() =>
			resolveModelOverride({
				bodyModelId: 'no-delimiter',
				bodyModelKind: 'chat',
				currentModelId: 'bridge::sdxl',
				currentModelKind: 'chat',
				isFanout: false,
				...resolvers,
			}),
		).toThrow(ModelOverrideError);
	});

	it('throws on an unconfigured endpoint', () => {
		expect(() =>
			resolveModelOverride({
				bodyModelId: 'ghost::model',
				bodyModelKind: 'chat',
				currentModelId: 'bridge::sdxl',
				currentModelKind: 'chat',
				isFanout: false,
				...resolvers,
			}),
		).toThrow(/not configured/);
	});
});

describe('resolveBranchIndex', () => {
	it('keeps a fan-out branch’s grid position', () => {
		expect(resolveBranchIndex(0, true)).toBe(0);
		expect(resolveBranchIndex(7, true)).toBe(7);
	});

	it('drops it on a non-fan-out send — a thread message has no grid position', () => {
		expect(resolveBranchIndex(3, false)).toBeNull();
	});

	it('rejects anything that isn’t a sane non-negative integer', () => {
		// `1e999` is the one that matters: JSON.parse hands it over as Infinity,
		// which `typeof x === 'number'` admits and SQLite stores as a float that
		// then sorts against every real index.
		expect(resolveBranchIndex(JSON.parse('1e999'), true)).toBeNull();
		expect(resolveBranchIndex(-1, true)).toBeNull();
		expect(resolveBranchIndex(1.5, true)).toBeNull();
		expect(resolveBranchIndex('2', true)).toBeNull();
		expect(resolveBranchIndex(undefined, true)).toBeNull();
		expect(resolveBranchIndex(null, true)).toBeNull();
	});

	// Indices are assigned past the highest already under the anchor, so
	// successive avatar-draw rounds climb well beyond one grid's worth.
	it('does not cap at the per-conversation branch ceiling', () => {
		expect(resolveBranchIndex(500, true)).toBe(500);
	});
});
