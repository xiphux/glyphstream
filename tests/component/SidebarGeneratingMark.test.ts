/**
 * The sidebar's generating mark has two states, and the distinction only pays
 * off in the arrangement that produced it: several multi-model conversations
 * fired at a one-model-at-a-time endpoint, where exactly one holds the GPU and
 * the rest are lined up behind the concurrency gate. Marked identically, the
 * working thread is findable only by opening every row in turn.
 *
 * Asserted at the component rather than in a unit test because the failure this
 * guards is a rendering one — the `{#if}` chain collapsing both states back onto
 * the same element, or the queued branch losing its place ahead of the
 * title-pending spinner — and because the seed→poll handover only exists once
 * the layout's effects are actually running.
 *
 * The poll is driven by calling `reconcileGenerating` directly: it's the same
 * module singleton the layout's interval feeds, and going through a faked
 * `fetch` on a 5s timer would test vitest's clock, not the sidebar.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/svelte';
import { createRawSnippet, flushSync } from 'svelte';
import type { createKitStub } from './_helpers/kit-runtime-stub.svelte';

const holder = vi.hoisted(() => ({ current: null as ReturnType<typeof createKitStub> | null }));
const invalidate = vi.hoisted(() => vi.fn(async (_key: string) => {}));

function stub() {
	if (!holder.current) throw new Error('the SvelteKit runtime stub was never built');
	return holder.current;
}

vi.mock('$app/env', () => ({
	browser: true,
	dev: false,
	building: false,
	version: 'test',
}));
vi.mock('$app/state', async () => {
	const { createKitStub } = await import('./_helpers/kit-runtime-stub.svelte');
	// Parked on the home route on purpose: the seeding effect deliberately skips
	// `page.params.id`, so standing inside one of these conversations would make
	// its row untestable from the seed.
	holder.current = createKitStub('http://localhost/');
	return {
		page: holder.current.page,
		navigating: holder.current.navigating,
		updated: { current: false },
	};
});
vi.mock('$app/navigation', () => ({
	goto: vi.fn(async () => {}),
	invalidate,
	refreshAll: vi.fn(async () => {}),
	afterNavigate: (callback: Parameters<ReturnType<typeof createKitStub>['afterNavigate']>[0]) =>
		stub().afterNavigate(callback),
	beforeNavigate: vi.fn(),
	pushState: vi.fn(),
	preloadData: vi.fn(async () => ({})),
}));
vi.mock('#lib/push-subscribe.js', () => ({ reconcileSubscription: vi.fn(async () => {}) }));
vi.mock('#lib/timezone-sync.js', () => ({ syncTimeZone: vi.fn(async () => {}) }));

vi.stubGlobal('__APP_VERSION__', '9.9.9');

const store = new Map<string, string>();
vi.stubGlobal('localStorage', {
	getItem: (k: string) => store.get(k) ?? null,
	setItem: (k: string, v: string) => void store.set(k, v),
	removeItem: (k: string) => void store.delete(k),
	clear: () => store.clear(),
});

// The layout's poll fires from an effect the moment anything is marked.
vi.stubGlobal(
	'fetch',
	vi.fn(async () => new Response(JSON.stringify({ ids: [], queuedIds: [] }))),
);

import AppLayout from '../../src/routes/(app)/+layout.svelte';
import {
	markGenerating,
	reconcileGenerating,
	resetGenerating,
} from '#lib/generating-conversations.svelte.js';

function conversation(id: string) {
	return { id, title: `Conversation ${id}`, updatedAt: 1, private: false };
}

/** The layout's own payload, trimmed to what its template reads. */
const layoutData = {
	user: { id: 'u1', displayName: 'Test', email: 't@e.st', role: 'admin', avatarUrl: null },
	conversations: [conversation('running'), conversation('waiting'), conversation('idle')],
	generatingIds: ['running', 'waiting'],
	queuedGeneratingIds: ['waiting'],
	prefs: { notificationsEnabled: false, favoriteModels: [], modelSets: [] },
	defaultModelId: null,
	models: [],
	customModels: [],
	enabledSkills: [],
	featureCategories: [],
	deferredLoaded: true,
	mcpSettled: true,
};

function renderLayout(patch: Partial<typeof layoutData> = {}) {
	render(AppLayout, {
		props: {
			data: { ...layoutData, ...patch } as never,
			children: createRawSnippet(() => ({ render: () => '<main>page</main>' })),
		},
	});
	stub().enter();
}

/** Every mark on one conversation's row, addressed through its link so a mark
 *  on some other row can never satisfy an assertion. */
function marksFor(convId: string): string[] {
	const row = document.querySelector(`a[href="/chat/${convId}"]`);
	if (!row) throw new Error(`no sidebar row for ${convId}`);
	return [...row.querySelectorAll('[role="img"]')].map((el) => el.getAttribute('aria-label') ?? '');
}

beforeEach(() => {
	stub().reset();
	resetGenerating();
	invalidate.mockClear();
});

describe('sidebar generating mark', () => {
	it('distinguishes the running conversation from the ones queued behind it', () => {
		renderLayout();

		expect(marksFor('running')).toEqual(['Generating a response']);
		expect(marksFor('waiting')).toEqual(['Queued, waiting to generate']);
		// Still marked, though — a queued thread is emphatically not a finished
		// one, and losing the mark entirely is the other way to fail this.
		expect(screen.getAllByRole('img', { name: /Generating a response|Queued/ })).toHaveLength(2);
	});

	it('leaves an idle conversation unmarked', () => {
		renderLayout();
		expect(marksFor('idle')).toEqual([]);
	});

	it('promotes a queued row when the poll reports it reached the front', () => {
		// The transition nothing else can observe: no client is listening to a
		// generation the user walked away from, so the poll is the only thing that
		// ever sees the line move.
		renderLayout();
		expect(marksFor('waiting')).toEqual(['Queued, waiting to generate']);

		reconcileGenerating(['running', 'waiting'], []);
		flushSync();
		expect(marksFor('waiting')).toEqual(['Generating a response']);
	});

	it('demotes a row the poll reports as queued again', () => {
		// A re-roll dispatched into a finished grid queues behind whatever else is
		// running, so the arrow points both ways.
		renderLayout();
		expect(marksFor('running')).toEqual(['Generating a response']);

		reconcileGenerating(['running', 'waiting'], ['running', 'waiting']);
		flushSync();
		expect(marksFor('running')).toEqual(['Queued, waiting to generate']);
	});

	it('drops both marks when the poll reports everything finished', () => {
		renderLayout();

		reconcileGenerating([], []);
		flushSync();
		expect(marksFor('running')).toEqual([]);
		expect(marksFor('waiting')).toEqual([]);
	});
});

// These go through the layout's real interval (the poll's outcome is the
// subject here, not the marks), so they drive vitest's clock.
describe('sidebar row of a generation the user walked away from', () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => vi.useRealTimers());

	/** The row as the new-chat page loaded it: before the first message
	 *  existed, so untitled. Nothing is generating at load; the chat page
	 *  marked it before the user left. */
	function renderLeftBehind() {
		const data = {
			...layoutData,
			conversations: [{ id: 'left', title: null as string | null, updatedAt: 1, private: false }],
			generatingIds: [],
			queuedGeneratingIds: [],
		};
		const children = createRawSnippet(() => ({ render: () => '<main>another page</main>' }));
		const { rerender } = render(AppLayout, { props: { data: data as never, children } });
		stub().enter();
		markGenerating('left');
		flushSync();
		return {
			titled: () =>
				rerender({
					data: { ...data, conversations: [{ ...data.conversations[0], title: 'Named' }] } as never,
					children,
				}),
		};
	}
	const refreshes = () => invalidate.mock.calls.filter(([k]) => k === 'app:conversations').length;

	it('re-pulls the list when the poll sees it finish', async () => {
		renderLeftBehind();
		await vi.advanceTimersByTimeAsync(5100);
		expect(marksFor('left')).toEqual([]);
		expect(refreshes()).toBe(1);
	});

	it('re-pulls again while the title is still missing, and stops once it lands', async () => {
		const { titled } = renderLeftBehind();
		await vi.advanceTimersByTimeAsync(5100);
		expect(refreshes()).toBe(1);

		// The server frees the in-flight slot before the auto-title task runs.
		await vi.advanceTimersByTimeAsync(4000);
		expect(refreshes()).toBe(2);

		await titled();
		await vi.advanceTimersByTimeAsync(20_000);
		expect(refreshes()).toBe(2);
	});

	it('gives up on a title that never comes', async () => {
		renderLeftBehind();
		await vi.advanceTimersByTimeAsync(5100);
		await vi.advanceTimersByTimeAsync(120_000);
		const settled = refreshes();
		expect(settled).toBeGreaterThan(2);
		await vi.advanceTimersByTimeAsync(120_000);
		expect(refreshes()).toBe(settled);
	});
});
