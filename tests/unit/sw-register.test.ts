/* @vitest-environment happy-dom */
/**
 * The service-worker update rules in `registerServiceWorker`: when a takeover
 * reloads the page, when a waiting worker is offered, and what Refresh does
 * when the worker it was for is gone. workbox-window is replaced by a fake that
 * records listeners, so each test fires the lifecycle events by hand.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Listener = (event: Record<string, unknown>) => void;

const wb = vi.hoisted(() => ({
	instance: null as null | {
		listeners: Map<string, Listener[]>;
		registration: { waiting: unknown };
		messageSkipWaiting: ReturnType<typeof import('vitest').vi.fn>;
	},
}));

vi.mock('workbox-window', async () => {
	const { vi: v } = await import('vitest');
	class Workbox {
		listeners = new Map<string, Listener[]>();
		registration = { waiting: null as unknown };
		messageSkipWaiting = v.fn();
		constructor() {
			wb.instance = this;
		}
		addEventListener(type: string, fn: Listener) {
			this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
		}
		register() {
			return Promise.resolve(this.registration);
		}
	}
	return { Workbox };
});

import { registerServiceWorker } from '#lib/sw/register.js';

function fake() {
	if (!wb.instance) throw new Error('Workbox was never constructed');
	return wb.instance;
}
function fire(type: string, event: Record<string, unknown> = {}) {
	for (const fn of fake().listeners.get(type) ?? []) fn(event);
}
/** Let `onNeedRefresh`'s and `register()`'s continuations run. */
async function settle() {
	for (let i = 0; i < 5; i++) await Promise.resolve();
}

let reload: ReturnType<typeof vi.fn>;
beforeEach(() => {
	wb.instance = null;
	reload = vi.fn();
	vi.spyOn(window, 'location', 'get').mockReturnValue({
		...window.location,
		reload,
	} as unknown as Location);
});
afterEach(() => {
	vi.restoreAllMocks();
});

function setup(shown: boolean) {
	const onNeedRefresh = vi.fn(async () => shown);
	const onRegistered = vi.fn();
	const refresh = registerServiceWorker({ onNeedRefresh, onRegistered });
	return { onNeedRefresh, onRegistered, refresh };
}

describe('registerServiceWorker', () => {
	it('reloads on takeover after a prompt this page showed', async () => {
		const { onNeedRefresh } = setup(true);
		fire('waiting');
		await settle();
		expect(onNeedRefresh).toHaveBeenCalledOnce();
		fire('controlling');
		expect(reload).toHaveBeenCalledOnce();
	});

	it('does not reload on takeover after a prompt the page declined to show', async () => {
		setup(false);
		fire('waiting');
		await settle();
		fire('controlling');
		expect(reload).not.toHaveBeenCalled();
	});

	it('does not reload when the first install claims the page', async () => {
		const { onNeedRefresh } = setup(true);
		fire('installed', { isUpdate: false });
		await settle();
		fire('controlling', { isUpdate: false });
		expect(onNeedRefresh).not.toHaveBeenCalled();
		expect(reload).not.toHaveBeenCalled();
	});

	it('prompts for a worker another tab installed', async () => {
		const { onNeedRefresh } = setup(true);
		fire('installed', { isExternal: true });
		await settle();
		expect(onNeedRefresh).toHaveBeenCalledOnce();
		fire('controlling', { isExternal: true });
		expect(reload).toHaveBeenCalledOnce();
	});

	it('Refresh activates the waiting worker without reloading itself', async () => {
		const { refresh } = setup(true);
		fake().registration.waiting = {};
		await settle();
		refresh();
		expect(fake().messageSkipWaiting).toHaveBeenCalledOnce();
		expect(reload).not.toHaveBeenCalled();
	});

	it('Refresh reloads when nothing is waiting any more', async () => {
		const { refresh, onRegistered } = setup(true);
		await settle();
		expect(onRegistered).toHaveBeenCalledOnce();
		refresh();
		expect(fake().messageSkipWaiting).not.toHaveBeenCalled();
		expect(reload).toHaveBeenCalledOnce();
	});
});
