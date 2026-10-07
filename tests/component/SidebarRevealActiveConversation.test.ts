/**
 * The Recents list brings the open conversation's row into view.
 *
 * The `(app)` layout remounts whenever the user passes through an `(auth)`
 * route — most visibly the app-lock unlock, which returns them to the thread
 * they were reading — and a remounted list starts at the top. Reaching that
 * conversation's overflow menu then meant scrolling to find it.
 *
 * happy-dom does no layout, so the geometry is faked: every row is ROW_PX
 * tall, stacked in DOM order, inside a pane VIEW_PX tall that honours its own
 * `scrollTop`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/svelte';
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

const ROW_PX = 40;
const VIEW_PX = 200; // five rows

const conversations = Array.from({ length: 30 }, (_, i) => ({
	id: `c${i}`,
	title: `Conversation ${i}`,
	updatedAt: new Date(2026, 0, 30 - i).toISOString(),
	private: false,
}));

const layoutData = {
	user: { id: 'u1', displayName: 'Test', email: 't@e.st', role: 'admin', avatarUrl: null },
	conversations,
	generatingIds: [],
	queuedGeneratingIds: [],
	prefs: { notificationsEnabled: false, favoriteModels: [], modelSets: [] },
	defaultModelId: null,
	models: [],
	customModels: [],
	enabledSkills: [],
	featureCategories: [],
	deferredLoaded: true,
	mcpSettled: true,
};

function rect(top: number, height: number): DOMRect {
	return {
		top,
		bottom: top + height,
		height,
		left: 0,
		right: 0,
		width: 0,
		x: 0,
		y: top,
	} as DOMRect;
}

function isPane(el: Element): boolean {
	return el.querySelector('[data-conversation-id]') !== null && el.tagName !== 'UL';
}

beforeEach(() => {
	vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(function (
		this: HTMLElement,
	) {
		return isPane(this) ? VIEW_PX : 0;
	});
	vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
		const id = (this as HTMLElement).dataset?.conversationId;
		if (id === undefined) return rect(0, isPane(this) ? VIEW_PX : 0);
		// Rows move up as the pane scrolls, exactly as a laid-out list would.
		const pane = this.closest('ul')!.parentElement!;
		return rect(Number(id.slice(1)) * ROW_PX - pane.scrollTop, ROW_PX);
	});
});

afterEach(() => {
	vi.restoreAllMocks();
});

function renderAt(href: string) {
	stub().reset(href);
	render(AppLayout, {
		props: {
			data: layoutData as never,
			children: createRawSnippet(() => ({ render: () => '<main>page</main>' })),
		},
	});
	flushSync();
	stub().enter();
	const pane = document.querySelector('[data-conversation-id]')!.closest('ul')!.parentElement!;
	return pane;
}

describe('recents reveal the active conversation', () => {
	it('scrolls a remounted list to an active row below the fold', () => {
		const pane = renderAt('http://localhost/chat/c20');
		// Row 20 sits at 800px; centred in a 200px pane is 800 - 80.
		expect(pane.scrollTop).toBe(720);
	});

	it('leaves the list alone when the active row is already visible', () => {
		const pane = renderAt('http://localhost/chat/c2');
		expect(pane.scrollTop).toBe(0);
	});

	it('does not move a visible row the user just tapped', () => {
		const pane = renderAt('http://localhost/chat/c20');
		const before = pane.scrollTop;
		// c21 is on screen (840..880 against a 720..920 view).
		stub().navigate('http://localhost/chat/c21');
		flushSync();
		expect(pane.scrollTop).toBe(before);
	});

	it('follows a navigation that lands on an off-screen row', () => {
		const pane = renderAt('http://localhost/chat/c0');
		expect(pane.scrollTop).toBe(0);
		// Search, or a link inside the chat, to a conversation far down.
		stub().navigate('http://localhost/chat/c25');
		flushSync();
		expect(pane.scrollTop).toBe(25 * ROW_PX - (VIEW_PX - ROW_PX) / 2);
	});

	it('does nothing off the chat route', () => {
		const pane = renderAt('http://localhost/gallery');
		expect(pane.scrollTop).toBe(0);
	});
});
