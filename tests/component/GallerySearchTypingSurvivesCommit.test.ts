/**
 * Holds the line on the gallery search box keeping what the user typed while a
 * debounced search was in flight.
 *
 * The box commits its text into `?q=` after a 250ms pause, and the search is a
 * navigation. By the time it lands the user has usually kept typing — so the
 * box must not be overwritten with the (shorter) query that was searched. An
 * `$effect` copying `data.q` into the box did exactly that: typing "bookstore"
 * with the search firing at "book" snapped the box back to "book", and in
 * ordinary typing it dropped letters at random.
 *
 * The other direction still has to work: a back-nav to a different query (or
 * to no query) is not the page's own commit, so the box follows the URL.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { goto } from '$app/navigation';
import type { createKitStub } from './_helpers/kit-runtime-stub.svelte';

const holder = vi.hoisted(() => ({ current: null as ReturnType<typeof createKitStub> | null }));

function stub() {
	if (!holder.current) throw new Error('the SvelteKit runtime stub was never built');
	return holder.current;
}

vi.mock('$app/environment', () => ({ browser: true, dev: false, building: false, version: 't' }));
vi.mock('$app/navigation', () => ({
	goto: vi.fn(async () => {}),
	invalidate: vi.fn(async () => {}),
	invalidateAll: vi.fn(async () => {}),
	afterNavigate: (callback: Parameters<ReturnType<typeof createKitStub>['afterNavigate']>[0]) =>
		stub().afterNavigate(callback),
	beforeNavigate: vi.fn(),
	replaceState: vi.fn(),
	pushState: vi.fn(),
}));
vi.mock('$app/state', async () => {
	const { createKitStub } = await import('./_helpers/kit-runtime-stub.svelte');
	holder.current = createKitStub('http://localhost:3000/gallery');
	return { page: holder.current.page, navigating: holder.current.navigating };
});

import GalleryPage from '../../src/routes/(app)/gallery/+page.svelte';

const browseData = {
	mode: 'browse' as const,
	kind: null,
	model: null,
	favorite: false,
	modelFacets: [],
	q: null,
	customModels: [],
};

function searchData(q: string) {
	return { ...browseData, mode: 'search' as const, q, searchItems: [] };
}

beforeEach(() => {
	stub().reset();
	vi.mocked(goto).mockClear();
	// Browse fetches its layout + units client-side on mount; an empty library.
	globalThis.fetch = vi.fn(
		async () =>
			new Response(JSON.stringify({ days: [], totalUnits: 0, units: [], total: 0 }), {
				status: 200,
			}),
	) as typeof fetch;
});

/** The `q` of the most recent search commit. */
function lastCommittedQ(): string | null {
	const calls = vi.mocked(goto).mock.calls;
	if (calls.length === 0) return null;
	return new URL(calls[calls.length - 1][0] as URL).searchParams.get('q');
}

async function renderAndStartSearch() {
	const user = userEvent.setup();
	const { rerender } = render(GalleryPage, { props: { data: browseData } });
	stub().enter();
	await user.click(screen.getByRole('button', { name: 'Search prompts' }));
	const box = screen.getByRole('searchbox', { name: 'Search prompts' });
	return {
		user,
		box: box as HTMLInputElement,
		/** Land a navigation the way Kit does: commit + dispatch, then new `data`. */
		land: async (
			href: string,
			type: 'goto' | 'popstate',
			data: typeof browseData | ReturnType<typeof searchData>,
		) => {
			stub().navigate(href, type);
			await rerender({ data });
		},
	};
}

describe('gallery search box', () => {
	it('keeps text typed after the debounce fired when that search lands', async () => {
		const { user, box, land } = await renderAndStartSearch();

		await user.type(box, 'book');
		await vi.waitFor(() => expect(lastCommittedQ()).toBe('book'));

		// The user keeps typing while the "book" search is in flight...
		await user.type(box, 'store');
		// ...and then it lands.
		await land('/gallery?q=book', 'goto', searchData('book'));

		expect(box.value).toBe('bookstore');
		// The pending debounce still searches the full text.
		await vi.waitFor(() => expect(lastCommittedQ()).toBe('bookstore'));
	});

	it('follows the URL on a back-nav to a query it did not commit', async () => {
		const { user, box, land } = await renderAndStartSearch();

		await user.type(box, 'lighthouse');
		await vi.waitFor(() => expect(lastCommittedQ()).toBe('lighthouse'));
		await land('/gallery?q=lighthouse', 'goto', searchData('lighthouse'));
		expect(box.value).toBe('lighthouse');

		await land('/gallery?q=harbor', 'popstate', searchData('harbor'));
		expect(box.value).toBe('harbor');
	});
});
