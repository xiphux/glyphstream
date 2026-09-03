import { describe, expect, it } from 'vitest';
import { deviceNotificationGap, type DeviceNotificationGap } from '$lib/push-subscribe';

// Baseline: opted in and genuinely receiving on this device. Each test
// overrides one axis, so the matrix reads as "what changes when X differs
// from healthy" (same shape as push-reconcile.test.ts).
const HEALTHY = {
	enabled: true,
	blocked: false,
	permission: 'granted' as NotificationPermission,
	hasLiveSubscription: true,
};

function gap(overrides: Partial<typeof HEALTHY>): DeviceNotificationGap {
	return deviceNotificationGap({ ...HEALTHY, ...overrides });
}

describe('deviceNotificationGap', () => {
	it('none: opted in and subscribed on this device', () => {
		expect(gap({})).toBe('none');
	});

	it('needs-permission: the pref is on but this install never granted permission', () => {
		// THE case this banner exists for. Deleting and re-adding an iOS PWA
		// resets permission to `default` and drops the subscription, but
		// `notificationsEnabled` is a per-user row and survives untouched — so the
		// checkbox renders checked on a device that receives nothing.
		// `reconcileSubscription` can't heal it: it skips on permission !==
		// 'granted' precisely so loading a page never surfaces a prompt.
		expect(gap({ permission: 'default', hasLiveSubscription: false })).toBe('needs-permission');
	});

	it('needs-subscription: permission granted but no live subscription', () => {
		// Reconciliation ran and failed (push service refused, key rotated
		// mid-flight). Distinct from needs-permission because the fix is a
		// re-subscribe, not a prompt.
		expect(gap({ hasLiveSubscription: false })).toBe('needs-subscription');
	});

	it('none: the pref is off, so a missing subscription is the expected state', () => {
		expect(gap({ enabled: false, hasLiveSubscription: false })).toBe('none');
		expect(gap({ enabled: false, permission: 'default', hasLiveSubscription: false })).toBe('none');
	});

	it('none: blocked — the existing disabled-reason already explains it', () => {
		// unsupported browser / iOS before Home Screen install / permission denied
		// / server push unconfigured all render their own message. Reporting a gap
		// on top would stack two warnings saying the same thing.
		expect(gap({ blocked: true, hasLiveSubscription: false })).toBe('none');
		expect(gap({ blocked: true, permission: 'denied', hasLiveSubscription: false })).toBe('none');
	});

	it('permission outranks the subscription probe', () => {
		// A stale subscription with no grant still can't deliver, and the fix is
		// the prompt — so don't report it as merely lapsed.
		expect(gap({ permission: 'default' })).toBe('needs-permission');
	});
});
