/* @vitest-environment happy-dom */

/**
 * Holds the line on when the mobile sidebar drawer closes itself.
 *
 * Two events look alike from inside a component and are not: SvelteKit COMMITS
 * a page — fresh `URL` and `data` objects into `$state.raw` fields — on every
 * load re-run, `invalidate()` included, and DISPATCHES `afterNavigate` only
 * when something navigated. The drawer must close on the second and sit still
 * through the first, and each edge has drawn blood:
 *
 *   - A commit with no navigation is what the post-first-paint pull of the
 *     deferred layout payload and `refreshConversations` on
 *     visibilitychange/pageshow do, both landing a network round trip after an
 *     app resume. An `$effect` reading `page.url` closed the drawer the user
 *     had just opened, but only if they opened it that fast.
 *   - A navigation to the href you are already on — the active conversation in
 *     Recents, Gallery while on Gallery — commits an equal URL with every node
 *     reused, so a key derived from the URL string never changes. Keying on
 *     that string left the drawer covering the page it had just "navigated" to.
 *
 * Nothing else catches either one: both type-check, both lint, and in the
 * second case both readings return the identical string.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { createRawSnippet, flushSync } from 'svelte';
import type { createKitStub } from './_helpers/kit-runtime-stub.svelte';

// The layout imports `$app/state` and `$app/navigation` at module scope, so the
// stub has to be built inside the first mock factory (which runs then) and
// handed back through a hoisted holder rather than a top-level binding.
const holder = vi.hoisted(() => ({ current: null as ReturnType<typeof createKitStub> | null }));

function stub() {
	if (!holder.current) throw new Error('the SvelteKit runtime stub was never built');
	return holder.current;
}

vi.mock('$app/environment', () => ({
	browser: true,
	dev: false,
	building: false,
	version: 'test',
}));
vi.mock('$app/state', async () => {
	const { createKitStub } = await import('./_helpers/kit-runtime-stub.svelte');
	holder.current = createKitStub('http://localhost/chat/abc');
	return {
		page: holder.current.page,
		navigating: holder.current.navigating,
		updated: { current: false },
	};
});
vi.mock('$app/navigation', () => ({
	goto: vi.fn(async () => {}),
	invalidate: vi.fn(async () => {}),
	invalidateAll: vi.fn(async () => {}),
	// Registered against the same stub, so `navigate()` below dispatches to the
	// layout's real callback while `refreshData()` deliberately does not.
	afterNavigate: (callback: Parameters<ReturnType<typeof createKitStub>['afterNavigate']>[0]) =>
		stub().afterNavigate(callback),
	beforeNavigate: vi.fn(),
	replaceState: vi.fn(),
	pushState: vi.fn(),
	preloadData: vi.fn(async () => ({})),
}));
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
	const { rerender } = render(AppLayout, {
		props: {
			data: layoutData as never,
			children: createRawSnippet(() => ({ render: () => '<main>page</main>' })),
		},
	});
	// The mobile drawer is the `translate-x-*` half of the aside's class; on sm+
	// the same element is the static sidebar (`sm:translate-x-0`).
	const aside = document.querySelector('aside');
	if (!aside) throw new Error('layout rendered without a sidebar');
	// A hydrated document dispatches one `type: 'enter'` navigation.
	stub().enter();
	return {
		aside,
		isOpen: () => aside.classList.contains('translate-x-0'),
		/**
		 * Both halves of what `invalidate()` commits: the stub republishes
		 * `page.*`, and `rerender` pushes the fresh `data` prop that Kit's
		 * `root.$set` would. Neither is a navigation.
		 */
		refresh: async (patch: Record<string, unknown> = {}) => {
			stub().refreshData(patch);
			await rerender({ data: { ...layoutData, ...patch } as never });
		},
	};
}

// One stub serves the whole file, so each test starts from a fresh document.
beforeEach(() => {
	stub().reset();
});

describe('mobile drawer', () => {
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

	it('closes on a navigation to the URL it is already on', async () => {
		const user = userEvent.setup();
		const drawer = renderLayout();

		await user.click(screen.getByLabelText('Open menu'));
		expect(drawer.isOpen()).toBe(true);

		// Tapping the active conversation in Recents. Kit commits an equal href
		// with every node reused, so nothing about the URL's value changes — but
		// the user did navigate, and the drawer is covering where they went.
		stub().navigate('http://localhost/chat/abc');
		flushSync();
		expect(drawer.isOpen()).toBe(false);
	});

	it('stays open when an invalidation commits fresh data at the same URL', async () => {
		const user = userEvent.setup();
		const drawer = renderLayout();

		await user.click(screen.getByLabelText('Open menu'));
		expect(drawer.isOpen()).toBe(true);

		// What `invalidate('app:conversations')` commits on resume: same href,
		// new URL and new data, no navigation. The drawer they just opened must
		// still be open.
		await drawer.refresh({ conversations: [] });
		expect(drawer.isOpen()).toBe(true);

		// A second one — the deferred-payload pull and the resume refresh both
		// land, and neither may take the drawer down.
		await drawer.refresh({ conversations: [] });
		expect(drawer.isOpen()).toBe(true);
	});

	it('still closes on a search-only navigation after a refresh', async () => {
		const user = userEvent.setup();
		const drawer = renderLayout();
		stub().navigate('http://localhost/');
		flushSync();

		await user.click(screen.getByLabelText('Open menu'));
		expect(drawer.isOpen()).toBe(true);

		await drawer.refresh();

		// Sidebar favourites navigate to `/?model=…`, which changes only the
		// search string when the user is already on `/`.
		stub().navigate('http://localhost/?model=gpt-4');
		flushSync();
		expect(drawer.isOpen()).toBe(false);
	});
});
