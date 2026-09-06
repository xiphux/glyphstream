/* @vitest-environment happy-dom */

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
 * Two places re-derive state on resume and both had this hole. This file
 * covers the root layout's badge backstop; the chat route carries the twin
 * wiring for the notification acknowledgment (`onPageShow` beside
 * `onVisibilityChange` there), which is not reachable from a component test —
 * if you delete one of the two bindings, delete the other's reason too.
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
vi.mock('$lib/sw/badge', () => ({ syncAppBadgeFromWindow: vi.fn(async () => {}) }));

import RootLayout from '../../src/routes/+layout.svelte';
import { syncAppBadgeFromWindow } from '$lib/sw/badge';

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
