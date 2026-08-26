/**
 * Reactive stand-in for the two halves of SvelteKit's client runtime that
 * URL-driven UI reads: `$app/state`'s `page` / `navigating`, and
 * `$app/navigation`'s `afterNavigate`.
 *
 * They live in one stub because the distinction between them is the thing most
 * worth getting right in a test. SvelteKit COMMITS a page — publishing a fresh
 * `URL` object and fresh `data` into fields that are `$state.raw`, so anything
 * subscribed to their identity re-runs — on every load re-run, `invalidate()`
 * included. It DISPATCHES `afterNavigate` only when something actually
 * navigated. The two overlap on an ordinary navigation and come apart at both
 * edges, which is where the bugs live:
 *
 *   - `refreshData()` — a commit with no navigation, i.e. what `invalidate()`
 *     does. Everything that only reacts to a navigation must sit still.
 *   - `navigate(sameHref)` — a navigation that commits an equal href. Kit
 *     reuses every node, so nothing about the URL's VALUE changes; anything
 *     keyed on a URL-derived string misses it entirely.
 *
 * Runes only compile in `.svelte` / `.svelte.ts` files, hence the module.
 */

/** The `page` fields the `(app)` layout and its children read. */
class PageStub {
	url = $state.raw(new URL('http://localhost/'));
	data = $state.raw<Record<string, unknown>>({});
	params = $state.raw<Record<string, string>>({});
	state = $state.raw<Record<string, unknown>>({});
	route = $state.raw<{ id: string | null }>({ id: null });
	form = $state.raw<unknown>(null);
	status = $state.raw(200);
	error = $state.raw<unknown>(null);
}

class NavigatingStub {
	current = $state.raw<unknown>(null);
	to = $state.raw<{ url: URL } | null>(null);
}

/** The shape `afterNavigate` callbacks receive, trimmed to what we dispatch. */
export interface StubNavigation {
	type: 'enter' | 'link';
}

export function createKitStub(href: string, data: Record<string, unknown> = {}) {
	const page = new PageStub();
	page.url = new URL(href);
	page.data = data;
	const navigating = new NavigatingStub();
	const afterNavigateCallbacks = new Set<(nav: StubNavigation) => void>();

	/** Publish a page the way Kit does: new `URL` and `data` objects. */
	function commit(nextHref?: string, patch: Record<string, unknown> = {}) {
		page.url = nextHref === undefined ? new URL(page.url.href) : new URL(nextHref, page.url);
		page.data = { ...page.data, ...patch };
	}

	function dispatch(type: StubNavigation['type']) {
		for (const cb of [...afterNavigateCallbacks]) cb({ type });
	}

	return {
		page,
		navigating,
		/**
		 * Restore a freshly-loaded document at `href` (or `nextHref`), and forget
		 * every registered callback. Belongs in a `beforeEach`.
		 *
		 * The mock factory that builds this stub runs once per test FILE, so
		 * without a reset each test inherits the previous one's URL — and a
		 * `navigate()` meant to model tapping a link for the CURRENT page
		 * silently becomes an ordinary different-href navigation, passing for the
		 * wrong reason. (It did.) Callbacks go too: the real `afterNavigate`
		 * unregisters when its component is destroyed, which this stub cannot
		 * observe, so a callback left over from a torn-down render would keep
		 * firing into dead state.
		 */
		reset(nextHref: string = href, nextData: Record<string, unknown> = data) {
			afterNavigateCallbacks.clear();
			page.url = new URL(nextHref);
			page.data = nextData;
		},
		/**
		 * Stand-in for `$app/navigation`'s `afterNavigate`. The real one registers
		 * through `onMount`; registering on the spot is equivalent here, since a
		 * component's init and its mount both precede any dispatch a test makes.
		 */
		afterNavigate(callback: (nav: StubNavigation) => void) {
			afterNavigateCallbacks.add(callback);
		},
		/** The initial load's `type: 'enter'` dispatch, after hydration. */
		enter() {
			dispatch('enter');
		},
		/**
		 * A completed navigation: commit, then dispatch — Kit's order. Pass the
		 * current href to model tapping a link for the page you are already on.
		 */
		navigate(nextHref: string) {
			commit(nextHref);
			dispatch('link');
		},
		/**
		 * What `invalidate()` does: commit only. No navigation happened, so
		 * nothing is dispatched — that asymmetry is the point of the stub.
		 */
		refreshData(patch: Record<string, unknown> = {}) {
			commit(undefined, patch);
		},
	};
}
