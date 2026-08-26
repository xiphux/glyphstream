/* @vitest-environment happy-dom */

/**
 * Holds the line on the mobile sidebar drawer surviving a background data
 * refresh.
 *
 * The drawer auto-closes on navigation — tapping a conversation should not
 * leave the drawer covering the thread it just opened. That rule lives in an
 * `$effect`, and the trap is what the effect depends on: `page.url` is a
 * `$state.raw` holding a URL *object*, and SvelteKit commits a `new URL(...)`
 * (plus new `data`) on every load re-run whose data changed — which is every
 * `invalidate()`, since it compares node data by reference. An effect that
 * reads `page.url` therefore fires when nothing navigated at all.
 *
 * Two invalidations land moments after an app resume — the post-first-paint
 * pull of the deferred layout payload, and `refreshConversations` on
 * visibilitychange/pageshow — so on the iOS PWA the drawer would close itself a
 * beat after the user opened it, but only if they opened it fast enough to
 * still be inside that window. Nothing else catches this: it type-checks, it
 * lints, and both readings return the identical string.
 */

import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { createRawSnippet, flushSync } from 'svelte';
import type { createPageStub } from './_helpers/page-state-stub.svelte';

// The layout imports `$app/state` at module scope, so the stub has to be built
// inside the mock factory (which runs then) and handed back through a hoisted
// holder rather than a top-level binding.
const holder = vi.hoisted(() => ({ current: null as ReturnType<typeof createPageStub> | null }));

vi.mock('$app/environment', () => ({
	browser: true,
	dev: false,
	building: false,
	version: 'test',
}));
vi.mock('$app/navigation', () => ({
	goto: vi.fn(async () => {}),
	invalidate: vi.fn(async () => {}),
	invalidateAll: vi.fn(async () => {}),
	afterNavigate: vi.fn(),
	beforeNavigate: vi.fn(),
	replaceState: vi.fn(),
	pushState: vi.fn(),
	preloadData: vi.fn(async () => ({})),
}));
vi.mock('$app/state', async () => {
	const { createPageStub } = await import('./_helpers/page-state-stub.svelte');
	holder.current = createPageStub('http://localhost/chat/abc');
	return {
		page: holder.current.page,
		navigating: holder.current.navigating,
		updated: { current: false },
	};
});
// Both fire network work from the layout's onMount and neither is under test.
vi.mock('$lib/push-subscribe', () => ({ reconcileSubscription: vi.fn(async () => {}) }));
vi.mock('$lib/timezone-sync', () => ({ syncTimeZone: vi.fn(async () => {}) }));

// Vite `define`s the version at build time; the sidebar footer renders it.
vi.stubGlobal('__APP_VERSION__', '9.9.9');

// happy-dom leaves the bare `localStorage` global undefined under Node, and the
// layout reads its collapse preference from it at init.
const store = new Map<string, string>();
vi.stubGlobal('localStorage', {
	getItem: (k: string) => store.get(k) ?? null,
	setItem: (k: string, v: string) => void store.set(k, v),
	removeItem: (k: string) => void store.delete(k),
	clear: () => store.clear(),
});

import AppLayout from '../../src/routes/(app)/+layout.svelte';

/** The `(app)` layout's own payload, trimmed to what its template reads. */
const layoutData = {
	user: { id: 'u1', displayName: 'Test', email: 't@e.st', role: 'admin', avatarUrl: null },
	conversations: [],
	generatingIds: [],
	prefs: { notificationsEnabled: false, favoriteModels: [], modelSets: [] },
	defaultModelId: null,
	models: [],
	customModels: [],
	enabledSkills: [],
	featureCategories: [],
	deferredLoaded: true,
	mcpSettled: true,
};

function renderLayout() {
	render(AppLayout, {
		props: {
			data: layoutData as never,
			children: createRawSnippet(() => ({ render: () => '<main>page</main>' })),
		},
	});
	// The mobile drawer is the `translate-x-*` half of the aside's class; on sm+
	// the same element is the static sidebar (`sm:translate-x-0`).
	const aside = document.querySelector('aside');
	if (!aside) throw new Error('layout rendered without a sidebar');
	return {
		aside,
		isOpen: () => aside.classList.contains('translate-x-0'),
	};
}

const stub = () => {
	if (!holder.current) throw new Error('$app/state stub was never built');
	return holder.current;
};

describe('mobile drawer vs. background refreshes', () => {
	it('opens from the hamburger and closes on navigation', async () => {
		const user = userEvent.setup();
		const drawer = renderLayout();
		expect(drawer.isOpen()).toBe(false);

		await user.click(screen.getByLabelText('Open menu'));
		expect(drawer.isOpen()).toBe(true);

		stub().navigate('http://localhost/chat/def');
		flushSync();
		expect(drawer.isOpen()).toBe(false);
	});

	it('stays open when an invalidation commits fresh data at the same URL', async () => {
		const user = userEvent.setup();
		const drawer = renderLayout();

		await user.click(screen.getByLabelText('Open menu'));
		expect(drawer.isOpen()).toBe(true);

		// What `invalidate('app:conversations')` commits on resume: same href,
		// new URL + data objects. The user has not navigated, so the drawer they
		// just opened must still be open.
		stub().refreshData({ conversations: [] });
		flushSync();
		expect(drawer.isOpen()).toBe(true);

		// A second one — the deferred-payload pull and the resume refresh both
		// land, and neither may take the drawer down.
		stub().refreshData({ conversations: [] });
		flushSync();
		expect(drawer.isOpen()).toBe(true);
	});

	it('still closes on a search-only navigation after a refresh', async () => {
		const user = userEvent.setup();
		const drawer = renderLayout();
		stub().navigate('http://localhost/');
		flushSync();

		await user.click(screen.getByLabelText('Open menu'));
		expect(drawer.isOpen()).toBe(true);

		stub().refreshData();
		flushSync();

		// Sidebar favourites navigate to `/?model=…`, which changes only the
		// search string when the user is already on `/`.
		stub().navigate('http://localhost/?model=gpt-4');
		flushSync();
		expect(drawer.isOpen()).toBe(false);
	});
});
