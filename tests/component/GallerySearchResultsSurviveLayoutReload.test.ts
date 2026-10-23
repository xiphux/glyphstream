/**
 * The gallery's load doesn't re-run when only the `(app)` layout reloads — on
 * every return to the app — so the page is handed a new `data` whose
 * `searchItems` is the SAME array as before. Copying it into the page's own
 * list again would undo every star and removal made since. Only a new array
 * (a load that really ran) may replace the list.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import type { MediaListItem } from '#lib/types/api.js';
import { goto } from '$app/navigation';
import type { createKitStub } from './_helpers/kit-runtime-stub.svelte';

const holder = vi.hoisted(() => ({ current: null as ReturnType<typeof createKitStub> | null }));

function stub() {
	if (!holder.current) throw new Error('the SvelteKit runtime stub was never built');
	return holder.current;
}

vi.mock('$app/env', () => ({ browser: true, dev: false, building: false, version: 't' }));
vi.mock('$app/navigation', () => ({
	goto: vi.fn(async () => {}),
	invalidate: vi.fn(async () => {}),
	refreshAll: vi.fn(async () => {}),
	afterNavigate: (callback: Parameters<ReturnType<typeof createKitStub>['afterNavigate']>[0]) =>
		stub().afterNavigate(callback),
	beforeNavigate: vi.fn(),
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
	sort: 'relevance' as const,
	customModels: [],
};

function searchData(q: string) {
	return { ...browseData, mode: 'search' as const, q, searchItems: [] as MediaListItem[] };
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

const item = {
	id: 'm1',
	kind: 'image',
	contentType: 'image/png',
	promptExcerpt: 'harbor at dusk',
	favorite: false,
	width: 512,
	height: 512,
	createdAt: 1,
} as unknown as MediaListItem;

describe('gallery search results', () => {
	it('keep a star made on the page through a layout-only reload', async () => {
		const user = userEvent.setup();
		const data = { ...searchData('harbor'), searchItems: [item] };
		const { rerender } = render(GalleryPage, { props: { data } });
		stub().enter();

		await user.click(screen.getByRole('button', { name: /^Open image harbor/ }));
		await user.click((await screen.findAllByRole('button', { name: 'Add to favorites' }))[0]);
		await user.keyboard('{Escape}');
		await vi.waitFor(() =>
			expect(screen.getByRole('button', { name: /^Open image, favorite/ })).toBeTruthy(),
		);

		// The layout reloads: a new `data`, the same `searchItems`.
		await rerender({ data: { ...data } });
		expect(screen.getByRole('button', { name: /^Open image, favorite/ })).toBeTruthy();

		// A search that really ran replaces the list.
		await rerender({ data: { ...data, searchItems: [{ ...item }] } });
		expect(screen.getByRole('button', { name: /^Open image harbor/ })).toBeTruthy();
	});
});
