import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { raiseAppBadge, syncAppBadge } from '$lib/sw/badge';

/**
 * The badge is derived from the notification tray rather than from a
 * counter we keep, so these tests are mostly about what happens when the
 * tray can't be read — which is the interesting case, since the platform
 * where this ships (iOS PWA) is also the one most likely to surprise us.
 */

type Nav = { setAppBadge: ReturnType<typeof vi.fn>; clearAppBadge: ReturnType<typeof vi.fn> };

function fakeNavigator(): Nav {
	return {
		setAppBadge: vi.fn(() => Promise.resolve()),
		clearAppBadge: vi.fn(() => Promise.resolve()),
	};
}

/** A registration whose tray holds `count` notifications. */
function registrationWith(count: number): ServiceWorkerRegistration {
	return {
		getNotifications: vi.fn(() => Promise.resolve(Array.from({ length: count }, () => ({})))),
	} as unknown as ServiceWorkerRegistration;
}

function registrationThatThrows(): ServiceWorkerRegistration {
	return {
		getNotifications: vi.fn(() => Promise.reject(new Error('nope'))),
	} as unknown as ServiceWorkerRegistration;
}

let nav: Nav;

beforeEach(() => {
	nav = fakeNavigator();
	vi.stubGlobal('navigator', nav);
});

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('raiseAppBadge', () => {
	it('sets the tray count', async () => {
		await raiseAppBadge(registrationWith(3));
		expect(nav.setAppBadge).toHaveBeenCalledWith(3);
	});

	it('falls back to a dot when the tray reads back empty', async () => {
		// We only call this right after showNotification, so an empty tray is
		// wrong. setAppBadge(0) CLEARS the badge rather than showing a zero,
		// which would turn a flaky query into no badge at all.
		await raiseAppBadge(registrationWith(0));
		expect(nav.setAppBadge).toHaveBeenCalledWith(undefined);
		expect(nav.clearAppBadge).not.toHaveBeenCalled();
	});

	it('falls back to a dot when the tray query throws', async () => {
		await raiseAppBadge(registrationThatThrows());
		expect(nav.setAppBadge).toHaveBeenCalledWith(undefined);
	});

	it('falls back to a dot with no registration at all', async () => {
		await raiseAppBadge(undefined);
		expect(nav.setAppBadge).toHaveBeenCalledWith(undefined);
	});

	it('never rejects when the platform refuses the badge', async () => {
		nav.setAppBadge.mockRejectedValueOnce(new Error('permission'));
		await expect(raiseAppBadge(registrationWith(1))).resolves.toBeUndefined();
	});
});

describe('syncAppBadge', () => {
	it('sets the remaining count', async () => {
		await syncAppBadge(registrationWith(2));
		expect(nav.setAppBadge).toHaveBeenCalledWith(2);
		expect(nav.clearAppBadge).not.toHaveBeenCalled();
	});

	it('clears when the tray is empty', async () => {
		await syncAppBadge(registrationWith(0));
		expect(nav.clearAppBadge).toHaveBeenCalled();
		expect(nav.setAppBadge).not.toHaveBeenCalled();
	});

	it('leaves the badge alone when the tray query throws', async () => {
		// Unknown is not zero: a stale badge beats wiping one still earned.
		await syncAppBadge(registrationThatThrows());
		expect(nav.clearAppBadge).not.toHaveBeenCalled();
		expect(nav.setAppBadge).not.toHaveBeenCalled();
	});

	it('leaves the badge alone with no registration (dev builds register no SW)', async () => {
		await syncAppBadge(undefined);
		expect(nav.clearAppBadge).not.toHaveBeenCalled();
		expect(nav.setAppBadge).not.toHaveBeenCalled();
	});

	it('leaves the badge alone when getNotifications is missing', async () => {
		await syncAppBadge({} as unknown as ServiceWorkerRegistration);
		expect(nav.clearAppBadge).not.toHaveBeenCalled();
		expect(nav.setAppBadge).not.toHaveBeenCalled();
	});
});

describe('platforms without the Badging API', () => {
	it('no-ops rather than throwing (Firefox, iOS < 16.4, non-installed tabs)', async () => {
		const bare = registrationWith(2);
		vi.stubGlobal('navigator', {});
		await expect(syncAppBadge(bare)).resolves.toBeUndefined();
		await expect(raiseAppBadge(bare)).resolves.toBeUndefined();
		// Bailed before even querying the tray — nothing to do with the answer.
		expect(bare.getNotifications).not.toHaveBeenCalled();
	});

	it('no-ops when navigator itself is absent (SSR)', async () => {
		vi.stubGlobal('navigator', undefined);
		await expect(syncAppBadge(registrationWith(1))).resolves.toBeUndefined();
	});
});
