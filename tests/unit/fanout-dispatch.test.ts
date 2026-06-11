/**
 * Unit tests for the fan-out dispatch guards extracted from the messages route.
 * The invariant that's otherwise awkward to reach through the full handler:
 *  - resolveModelOverride: a fan-out branch's model is TRANSIENT — it must never
 *    be persisted (persist:false), or N concurrent branches clobber the
 *    conversation's stored default. This is the regression guard the plan called
 *    a linchpin ("silently rewrites users' conversation models").
 */
import { describe, it, expect } from 'vitest';
import { resolveModelOverride, ModelOverrideError } from '$lib/server/messages/fanout-dispatch';

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
