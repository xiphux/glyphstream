/* @vitest-environment happy-dom */

/**
 * Component test for the preferences page's per-device notification gap.
 *
 * `notificationsEnabled` is one row per USER; a push subscription belongs to
 * one browser install. The banner exists so a device that renders a checked
 * box but holds no subscription says so. Two of its guards live entirely in
 * async ordering inside `onMount`, which is why they need a real component
 * test: `pnpm check` and a node-env unit test both pass with either broken,
 * since Svelte resolves to the SSR runtime under node and effects never run.
 *
 * `deviceNotificationGap` itself is pure and covered by
 * tests/unit/push-device-gap.test.ts. What's asserted here is the wiring the
 * pure function can't see — which value reaches it, and when.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import type { UserPreferences } from '$lib/types/api';

vi.mock('$app/environment', () => ({ browser: true, dev: false, building: false, version: 't' }));

import PreferencesPage from '../../src/routes/(app)/settings/preferences/+page.svelte';

// base64url of "test-key" — urlBase64ToUint8Array runs it through atob, so it
// has to actually decode.
const VAPID = 'dGVzdC1rZXk';

function mkPrefs(over: Partial<UserPreferences> = {}): UserPreferences {
	return {
		name: '',
		aboutYou: '',
		customInstructions: '',
		enterBehavior: 'send',
		showGreeting: true,
		theme: 'glyphstream',
		colorScheme: 'system',
		notificationsEnabled: true,
		notificationsShowContent: true,
		notificationsForegroundToast: true,
		favoriteModels: [],
		avatarModelId: null,
		modelSets: [],
		trustedMcpTools: [],
		autoCompactionEnabled: false,
		autoCompactionThreshold: 80,
		timezone: null,
		defaultDisabledFeatures: [],
		...over,
	};
}

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((r) => {
		resolve = r;
	});
	return { promise, resolve };
}

/** A PushSubscription stand-in. `options` carries no applicationServerKey, so
 *  subscriptionMatchesKey takes its "browser doesn't expose the key → assume a
 *  match" branch and these tests don't depend on key-comparison details. */
function mkSubscription() {
	return {
		endpoint: 'https://push.example/endpoint-1',
		options: {} as { applicationServerKey?: ArrayBuffer },
		toJSON: () => ({
			endpoint: 'https://push.example/endpoint-1',
			keys: { p256dh: 'p', auth: 'a' },
		}),
		unsubscribe: vi.fn(async () => true),
	};
}

const getSubscription = vi.fn<() => Promise<unknown>>();
const pushSubscribe = vi.fn<() => Promise<unknown>>();
const notification = {
	permission: 'default' as NotificationPermission,
	requestPermission: vi.fn(async () => notification.permission),
};

// Responses keyed by "<METHOD> <pathname>", so a test can swap one route (a
// deferred config, a failing PATCH) without restating the others.
let routes: Record<string, () => Promise<Response>>;

function jsonResponse(body: unknown) {
	return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
}

beforeEach(() => {
	getSubscription.mockReset();
	pushSubscribe.mockReset();
	notification.permission = 'default';
	notification.requestPermission.mockClear();

	routes = {
		'GET /api/push/config': () => jsonResponse({ enabled: true, vapidPublicKey: VAPID }),
		'POST /api/push/subscribe': () => jsonResponse({ ok: true }),
		'DELETE /api/push/subscribe': () => jsonResponse({ ok: true }),
		'PATCH /api/user/preferences': () => jsonResponse(mkPrefs()),
	};

	Object.defineProperty(navigator, 'serviceWorker', {
		configurable: true,
		value: {
			ready: Promise.resolve({ pushManager: { getSubscription, subscribe: pushSubscribe } }),
		},
	});
	// isPushSupported only tests `'PushManager' in window`, so presence is all
	// this needs to be.
	Object.defineProperty(window, 'PushManager', { configurable: true, value: class {} });
	Object.defineProperty(window, 'Notification', { configurable: true, value: notification });

	globalThis.fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
		const url = new URL(String(input instanceof Request ? input.url : input), 'http://localhost');
		const key = `${init?.method ?? (input instanceof Request ? input.method : 'GET')} ${url.pathname}`;
		const route = routes[key];
		if (!route) throw new Error(`unstubbed request: ${key}`);
		return route();
	}) as unknown as typeof fetch;
});

afterEach(() => {
	vi.restoreAllMocks();
});

/** Let the onMount chain (config fetch → reconcile → probe) run to completion. */
async function settle() {
	for (let i = 0; i < 12; i++) await Promise.resolve();
	await new Promise((r) => setTimeout(r, 0));
	for (let i = 0; i < 12; i++) await Promise.resolve();
}

const bannerText = /This device isn't set up to receive notifications/;

describe('Preferences page — per-device notification gap', () => {
	it('raises the banner when the pref is on but this install never granted permission', async () => {
		// The case the whole feature exists for: deleting and re-adding an iOS
		// PWA resets permission to `default` and drops the subscription, while
		// notificationsEnabled — a per-user row — survives. Reconciliation can't
		// heal it (it must never prompt), so the page has to say so itself.
		notification.permission = 'default';
		getSubscription.mockResolvedValue(null);

		render(PreferencesPage, {
			props: { data: { prefs: mkPrefs({ notificationsEnabled: true }), featureCategories: [] } },
		});
		await settle();

		expect(screen.getByText(bannerText)).toBeInTheDocument();
		expect(screen.getByRole('button', { name: 'Enable on this device' })).toBeInTheDocument();
		// Never prompt from a page load — only the button's click handler may.
		expect(notification.requestPermission).not.toHaveBeenCalled();
	});

	it('stays quiet and confirms the device when a live subscription is present', async () => {
		notification.permission = 'granted';
		getSubscription.mockResolvedValue(mkSubscription());

		render(PreferencesPage, {
			props: { data: { prefs: mkPrefs({ notificationsEnabled: true }), featureCategories: [] } },
		});
		await settle();

		expect(screen.queryByText(bannerText)).not.toBeInTheDocument();
		expect(screen.getByText(/this device is subscribed/)).toBeInTheDocument();
	});

	it('does not claim success when subscribe() hands back a stale-key subscription', async () => {
		// subscribe() returns `existing ?? pushManager.subscribe(...)` with no key
		// check, so it reports ok for a rotated-key subscription it merely
		// re-POSTs — while the probe counts one as absent. Trusting `ok` cleared
		// the banner and asserted "this device is subscribed" on a device that
		// still could not receive.
		notification.permission = 'granted';
		const stale = mkSubscription();
		// A different key than the server advertises: VAPID decodes to 8 bytes.
		stale.options = { applicationServerKey: new Uint8Array([1, 2, 3]).buffer };
		getSubscription.mockResolvedValue(stale);

		const user = userEvent.setup();
		render(PreferencesPage, {
			props: { data: { prefs: mkPrefs({ notificationsEnabled: false }), featureCategories: [] } },
		});
		await settle();
		expect(screen.queryByText(bannerText)).not.toBeInTheDocument();

		await user.click(screen.getByRole('checkbox', { name: /Enable notifications/ }));
		await settle();

		expect(screen.getByText(bannerText)).toBeInTheDocument();
		expect(screen.queryByText(/this device is subscribed/)).not.toBeInTheDocument();
	});

	it('discards a probe that resolves after a toggle wrote a fresher value', async () => {
		// The probe reads the browser asynchronously, so its write can land after
		// a handler's. Without the generation guard the stale `true` overwrites
		// the handler's `false` and clears a banner that should be showing.
		notification.permission = 'granted';
		const probe = deferred<unknown>();
		const subscription = mkSubscription();
		getSubscription
			.mockResolvedValueOnce(subscription) // reconcile
			.mockReturnValueOnce(probe.promise) // the mount probe — held open
			.mockResolvedValue(subscription); // unsubscribe()'s own read

		// The turn-off PATCH fails, so notificationsEnabled stays true and the
		// gap banner is observable. (With the pref off, every gap renders as
		// 'none' and the clobber would be invisible.)
		routes['PATCH /api/user/preferences'] = () =>
			Promise.resolve(new Response('nope', { status: 500 }));

		const user = userEvent.setup();
		render(PreferencesPage, {
			props: { data: { prefs: mkPrefs({ notificationsEnabled: true }), featureCategories: [] } },
		});
		await settle();

		// Probe still in flight: no banner yet, because deviceSubscribed is null.
		expect(screen.queryByText(bannerText)).not.toBeInTheDocument();

		await user.click(screen.getByRole('checkbox', { name: /Enable notifications/ }));
		await settle();
		// The handler's own write stands: subscription revoked, pref save failed.
		expect(screen.getByText(bannerText)).toBeInTheDocument();

		probe.resolve(subscription); // stale `true` arrives late
		await settle();

		expect(screen.getByText(bannerText)).toBeInTheDocument();
		expect(screen.queryByText(/this device is subscribed/)).not.toBeInTheDocument();
	});

	it('discards a probe when the toggle ran during the config fetch', async () => {
		// The generation has to be snapshotted before the FIRST await, not merely
		// before the probe. masterDisabled tests `serverConfigured === false` and
		// serverConfigured is null while loading, so the checkbox is live for the
		// whole config fetch — a snapshot taken after it reads the already-bumped
		// counter and the stale probe sails through the check it exists to fail.
		notification.permission = 'granted';
		const config = deferred<Response>();
		routes['GET /api/push/config'] = () => config.promise;
		getSubscription.mockResolvedValue(mkSubscription());
		routes['PATCH /api/user/preferences'] = () =>
			Promise.resolve(new Response('nope', { status: 500 }));

		const user = userEvent.setup();
		render(PreferencesPage, {
			props: { data: { prefs: mkPrefs({ notificationsEnabled: true }), featureCategories: [] } },
		});

		// Still fetching the config — and the toggle is interactive.
		const box = screen.getByRole('checkbox', { name: /Enable notifications/ });
		expect(box).not.toBeDisabled();
		await user.click(box);
		await settle();
		expect(screen.getByText(bannerText)).toBeInTheDocument();

		config.resolve(new Response(JSON.stringify({ enabled: true, vapidPublicKey: VAPID })));
		await settle();

		// The probe reads the subscription the browser hasn't finished shedding.
		// It must not overwrite what the handler already established.
		expect(screen.getByText(bannerText)).toBeInTheDocument();
		expect(screen.queryByText(/this device is subscribed/)).not.toBeInTheDocument();
	});

	it('still records the probe when the toggle bumped the guard but wrote nothing', async () => {
		// toggleMaster increments the generation before its first await, then has
		// exits that write deviceSubscribed nothing — here the catch, reached via
		// unsubscribe()'s unguarded getSubscription(). Nothing else repairs the
		// field, so discarding the probe on generation alone pinned it at null —
		// and a null pins deviceGap to 'none', hiding the banner AND the button
		// that fixes it on a device that genuinely can't receive.
		notification.permission = 'granted';
		const probe = deferred<unknown>();
		getSubscription
			.mockResolvedValueOnce(mkSubscription()) // reconcile
			.mockReturnValueOnce(probe.promise) // the mount probe — held open
			// unsubscribe()'s read is unguarded, so this rejection escapes into
			// toggleMaster's catch, which returns without writing deviceSubscribed.
			.mockRejectedValue(new Error('service worker went away'));

		const user = userEvent.setup();
		render(PreferencesPage, {
			props: { data: { prefs: mkPrefs({ notificationsEnabled: true }), featureCategories: [] } },
		});
		await settle();

		// The probe must still be in flight when the toggle bumps the generation,
		// or the bump lands after the write and there is nothing to discard.
		await user.click(screen.getByRole('checkbox', { name: /Enable notifications/ }));
		await settle();
		expect(screen.queryByText(bannerText)).not.toBeInTheDocument(); // still null

		probe.resolve(null);
		await settle();

		expect(screen.getByText(bannerText)).toBeInTheDocument();
		expect(screen.getByRole('button', { name: 'Re-subscribe this device' })).toBeInTheDocument();
	});
});
