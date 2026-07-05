import { describe, expect, it } from 'vitest';
import { decideReconcile, type ReconcileAction } from '$lib/push-subscribe';

// Baseline: a fully opted-in, healthy state. Each test overrides one axis so
// the matrix reads as "what changes when X differs from healthy."
const HEALTHY = {
	enabled: true,
	pushSupported: true,
	permission: 'granted' as NotificationPermission,
	serverConfigured: true,
	hasSubscription: true,
	keyMatches: true,
};

function decide(overrides: Partial<typeof HEALTHY>): ReconcileAction {
	return decideReconcile({ ...HEALTHY, ...overrides });
}

describe('decideReconcile', () => {
	it('register-existing: healthy opted-in state re-POSTs to heal a pruned server row', () => {
		// The browser kept its subscription but the server row was pruned by a
		// 404/410 on a prior send — re-registering restores the endpoint.
		expect(decide({})).toBe('register-existing');
	});

	it('subscribe-new: opted in + granted, but the browser subscription is gone', () => {
		// THE regression this whole change exists for: pref reads "on", permission
		// still granted, but the OS/push service dropped the subscription (iOS
		// eviction, PWA re-add). Before the fix nothing re-subscribed and
		// notifications silently stopped; now we create a fresh one.
		expect(decide({ hasSubscription: false })).toBe('subscribe-new');
	});

	it('resubscribe: subscription exists but is bound to a rotated VAPID key', () => {
		// Operator regenerated the keypair — the old subscription can never
		// receive our sends. Drop it and subscribe against the current key.
		expect(decide({ keyMatches: false })).toBe('resubscribe');
	});

	it('skip: the user has not opted in', () => {
		// Permission may even be granted from a past opt-in, but the pref is off —
		// never auto-resubscribe someone who turned notifications off.
		expect(decide({ enabled: false })).toBe('skip');
		expect(decide({ enabled: false, hasSubscription: false })).toBe('skip');
	});

	it('skip: permission is not granted (never prompt on load)', () => {
		expect(decide({ permission: 'default' })).toBe('skip');
		expect(decide({ permission: 'denied' })).toBe('skip');
		// Even with no subscription to heal, a missing grant must not prompt.
		expect(decide({ permission: 'default', hasSubscription: false })).toBe('skip');
	});

	it('skip: push is unsupported (SSR, old iOS, no PushManager)', () => {
		expect(decide({ pushSupported: false })).toBe('skip');
	});

	it('skip: the server has push disabled/unconfigured', () => {
		// No VAPID config server-side — nothing to register against.
		expect(decide({ serverConfigured: false })).toBe('skip');
		expect(decide({ serverConfigured: false, hasSubscription: false })).toBe('skip');
	});
});
