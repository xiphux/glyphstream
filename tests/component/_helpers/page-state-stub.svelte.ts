/**
 * Reactive stand-in for `$app/state`'s `page` / `navigating`, with the one
 * property that matters to the tests that use it: SvelteKit's real `page` holds
 * its fields in `$state.raw`, so committing a load result publishes a *new*
 * `URL` object (`url: new URL(url)` in `load_route`) and a new `data` object
 * even when the user never navigated. Anything subscribed to those objects'
 * identity re-runs.
 *
 * `refreshData()` reproduces exactly that: what a client-side `invalidate(...)`
 * commits when a load returns fresh data at the same URL.
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

export function createPageStub(href: string, data: Record<string, unknown> = {}) {
	const page = new PageStub();
	page.url = new URL(href);
	page.data = data;
	const navigating = new NavigatingStub();

	return {
		page,
		navigating,
		/** A genuine navigation, committed the way SvelteKit commits one. */
		navigate(nextHref: string) {
			page.url = new URL(nextHref, page.url);
			page.data = { ...page.data };
		},
		/**
		 * What `invalidate()` commits: the same href, but a brand-new `URL` and
		 * `data`. Nothing navigated — only the object identities changed.
		 */
		refreshData(patch: Record<string, unknown> = {}) {
			page.url = new URL(page.url.href);
			page.data = { ...page.data, ...patch };
		},
	};
}
