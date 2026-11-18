/**
 * Holds the line on WHICH events count as the app coming back to the front.
 *
 * A resume is two events, and on the platform this feature exists for it is
 * usually the second one. iOS suspends a backgrounded standalone PWA and
 * restores it from the bfcache: that restore fires `pageshow` and NOT
 * `visibilitychange`. Anything wired to visibility alone therefore skips the
 * LONG background waits — which are exactly the ones that got an OS
 * notification in the first place, so the miss is perfectly correlated with the
 * case that needs it. Symptom: a completion notification and its icon badge
 * that never retract, no matter how long the user looks at the thread they
 * point at.
 *
 * Three places re-derive state on resume and pair the two events: the root
 * layout's badge backstop, which this file covers; the (app) layout's
 * conversation refresh; and the chat route's notification acknowledgment
 * (`onPageShow` beside `onVisibilityChange` there), the badge's twin, which is
 * not reachable from a component test — if you delete one of those two
 * bindings, delete the other's reason too.
 *
 * The mount case is its own beat: a cold launch fires no resume event at all,
 * so a notification swiped away while the app wasn't running would leave its
 * count on the icon for the whole session.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/svelte';
import { createRawSnippet } from 'svelte';
import type { createKitStub } from './_helpers/kit-runtime-stub.svelte';

// The layout imports `$app/state` at module scope, so the stub has to be built
// inside the mock factory (which runs then) and handed back through a hoisted
// holder rather than a top-level binding. See tests/component/README.md.
const holder = vi.hoisted(() => ({ current: null as ReturnType<typeof createKitStub> | null }));

function stub() {
	if (!holder.current) throw new Error('the SvelteKit runtime stub was never built');
	return holder.current;
}

vi.mock('$app/navigation', () => ({ goto: vi.fn(async () => {}) }));
vi.mock('$app/paths', () => ({ resolve: (p: string) => p }));
vi.mock('$app/state', async () => {
	const { createKitStub } = await import('./_helpers/kit-runtime-stub.svelte');
	holder.current = createKitStub('http://localhost:3000/');
	return { page: holder.current.page, navigating: holder.current.navigating };
});
vi.mock('#lib/sw/badge.js', () => ({ syncAppBadgeFromWindow: vi.fn(async () => {}) }));
const sw = vi.hoisted(() => ({ registered: 0, update: vi.fn(async () => {}) }));
vi.mock('#lib/sw/register.js', () => ({
	registerServiceWorker: (opts: { onRegistered: (r: unknown) => void }) => {
		sw.registered++;
		opts.onRegistered({ update: sw.update });
		return () => {};
	},
}));

import RootLayout from '../../src/routes/+layout.svelte';
import { syncAppBadgeFromWindow } from '#lib/sw/badge.js';

const synced = vi.mocked(syncAppBadgeFromWindow);

/** `pageshow` with a real `persisted` flag — happy-dom has no PageTransitionEvent. */
function pageShow(persisted: boolean): Event {
	const event = new Event('pageshow');
	Object.defineProperty(event, 'persisted', { value: persisted });
	return event;
}

function mountLayout() {
	return render(RootLayout, {
		props: {
			children: createRawSnippet(() => ({ render: () => '<div data-testid="child"></div>' })),
		},
	});
}

describe('app-resume badge backstop', () => {
	beforeEach(() => {
		// Not optional even though nothing here navigates: the mock factory runs
		// once per test FILE, so without it tests inherit each other's URL.
		stub().reset();
		synced.mockClear();
	});

	it('re-derives the badge on mount, where no resume event will ever fire', () => {
		mountLayout();
		expect(synced).toHaveBeenCalledTimes(1);
	});

	it('re-derives on a bfcache restore, which fires no visibilitychange', () => {
		mountLayout();
		synced.mockClear();
		window.dispatchEvent(pageShow(true));
		expect(synced).toHaveBeenCalledTimes(1);
	});

	it('sits still on a fresh load’s pageshow — mount already covered it', () => {
		mountLayout();
		synced.mockClear();
		window.dispatchEvent(pageShow(false));
		expect(synced).not.toHaveBeenCalled();
	});

	it('still re-derives on the ordinary visibilitychange resume', () => {
		mountLayout();
		synced.mockClear();
		document.dispatchEvent(new Event('visibilitychange'));
		expect(synced).toHaveBeenCalledTimes(1);
	});
});

/**
 * The service-worker update check rides the same two resume events. Its
 * listeners outlive an unmount (the root layout never unmounts in the app), so
 * an earlier test's mount answers too: these assert a call, not a count.
 */
describe('app-resume update check', () => {
	const update = sw.update;

	beforeEach(() => {
		stub().reset();
		update.mockClear();
		sw.registered = 0;
		vi.stubEnv('PROD', true);
		Object.defineProperty(navigator, 'serviceWorker', {
			configurable: true,
			value: {
				addEventListener: () => {},
				removeEventListener: () => {},
				getRegistration: async () => undefined,
			},
		});
		return () => {
			vi.unstubAllEnvs();
			Reflect.deleteProperty(navigator, 'serviceWorker');
		};
	});

	/** Mount, and wait out onMount's dynamic import of the registration module. */
	async function mountRegistered() {
		mountLayout();
		await vi.waitFor(() => expect(sw.registered).toBe(1));
	}

	it('checks on a bfcache restore, which fires no visibilitychange', async () => {
		await mountRegistered();
		window.dispatchEvent(pageShow(true));
		expect(update).toHaveBeenCalled();
	});

	it('checks on the ordinary visibilitychange resume', async () => {
		await mountRegistered();
		document.dispatchEvent(new Event('visibilitychange'));
		expect(update).toHaveBeenCalled();
	});
});
