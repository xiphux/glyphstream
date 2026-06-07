/**
 * Unit tests for the fan-out dispatch guards extracted from the messages route.
 * Two invariants that are otherwise awkward to reach through the full handler:
 *  - resolveModelOverride: a fan-out branch's model is TRANSIENT — it must never
 *    be persisted (persist:false), or N concurrent branches clobber the
 *    conversation's stored default. This is the regression guard the plan called
 *    a linchpin ("silently rewrites users' conversation models").
 *  - isValidReplaceTarget: a regenerate's replacesMessageId triggers a real
 *    server-side delete, so only an assistant sibling of the fan-out parent is
 *    honored.
 */
import { describe, it, expect } from 'vitest';
import {
	resolveModelOverride,
	isValidReplaceTarget,
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

describe('isValidReplaceTarget', () => {
	const parent = 'user-1';
	it('accepts an assistant sibling parented to the fan-out user message', () => {
		expect(isValidReplaceTarget({ role: 'assistant', parentMessageId: parent }, parent)).toBe(true);
	});
	it('rejects a non-assistant (e.g. a user message with edit-siblings)', () => {
		expect(isValidReplaceTarget({ role: 'user', parentMessageId: parent }, parent)).toBe(false);
	});
	it('rejects a message parented elsewhere', () => {
		expect(isValidReplaceTarget({ role: 'assistant', parentMessageId: 'other' }, parent)).toBe(
			false,
		);
	});
	it('rejects an unknown id (null/undefined target)', () => {
		expect(isValidReplaceTarget(null, parent)).toBe(false);
		expect(isValidReplaceTarget(undefined, parent)).toBe(false);
	});
});
