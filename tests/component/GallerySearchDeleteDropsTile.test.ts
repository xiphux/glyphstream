/**
 * In search mode the gallery renders the ranked `searchItems`, not the browse
 * feed, so a delete made there has to drop the row from that list — the tile
 * and the "N results" count both read it. Reseeding the browse feed instead
 * refreshed a view nobody was looking at and left the deleted tile on screen.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import type { MediaListItem } from '#lib/types/api.js';
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
	holder.current = createKitStub('http://localhost:3000/gallery?q=harbor');
	return { page: holder.current.page, navigating: holder.current.navigating };
});
vi.mock('#lib/confirm.svelte.js', () => ({
	confirmDialog: { ask: vi.fn(async () => true), pending: null },
}));

import GalleryPage from '../../src/routes/(app)/gallery/+page.svelte';

function mediaItem(id: string, prompt: string): MediaListItem {
	return {
		id,
		kind: 'image',
		contentType: 'image/png',
		byteSize: 1024,
		promptExcerpt: prompt,
		promptFull: prompt,
		originalPrompt: null,
		sourceModel: 'bridge::flux-dev',
		sourceEndpointId: 'bridge',
		conversationId: null,
		conversationTitle: null,
		favorite: false,
		width: 512,
		height: 512,
		createdAt: 1,
	} as unknown as MediaListItem;
}

const data = {
	mode: 'search' as const,
	kind: null,
	model: null,
	favorite: false,
	modelFacets: [],
	q: 'harbor',
	sort: 'relevance' as const,
	customModels: [],
	searchItems: [mediaItem('m1', 'harbor at dusk'), mediaItem('m2', 'harbor at dawn')],
};

let calls: Array<{ url: string; method: string }>;

beforeEach(() => {
	stub().reset();
	calls = [];
	globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
		calls.push({ url, method: init?.method ?? 'GET' });
		return new Response(
			JSON.stringify({ days: [], totalUnits: 0, units: [], total: 0, deleted: 1 }),
			{ status: 200 },
		);
	}) as typeof fetch;
});

describe('gallery search: delete', () => {
	it('drops a single-deleted result from the grid', async () => {
		const user = userEvent.setup();
		render(GalleryPage, { props: { data } });
		stub().enter();

		expect(screen.getAllByRole('button', { name: /^Open image/ })).toHaveLength(2);
		await user.click(screen.getAllByRole('button', { name: 'Delete this media' })[0]);

		await vi.waitFor(() =>
			expect(screen.queryAllByRole('button', { name: /^Open image harbor at dusk/ })).toHaveLength(
				0,
			),
		);
		expect(calls.some((c) => c.method === 'DELETE' && c.url === '/api/media/m1')).toBe(true);
		expect(screen.getByText(/result/).textContent).toMatch(/^\s*1 result /);
		expect(calls.some((c) => c.url.startsWith('/api/media/layout'))).toBe(false);
	});

	it('drops bulk-deleted results from the grid', async () => {
		const user = userEvent.setup();
		render(GalleryPage, { props: { data } });
		stub().enter();

		await user.click(screen.getByRole('button', { name: 'Select items' }));
		await user.click(screen.getAllByRole('button', { name: 'Select image' })[0]);
		await user.click(screen.getByRole('button', { name: 'Delete' }));

		await vi.waitFor(() =>
			expect(screen.queryAllByRole('button', { name: /^Open image harbor at dusk/ })).toHaveLength(
				0,
			),
		);
		expect(calls.some((c) => c.method === 'POST' && c.url === '/api/media/bulk-delete')).toBe(true);
		expect(screen.getByText(/result/).textContent).toMatch(/^\s*1 result /);
	});
});
