/**
 * Holds the line on the (app) layout's app-lock check — the installed app's
 * half of app lock (server/auth/app-lock.ts): cover on hide, ask the server on
 * resume, and only then uncover or go to /unlock.
 *
 * The check is one request at a time, and the hazards are all about a request
 * outliving the moment it was made for:
 *
 *   - A keep-alive can be in flight when iOS suspends the app. Guarding with a
 *     plain "in flight" flag made the resume's own check a no-op, so the page
 *     stayed covered until the next tick — or the stale request settled with a
 *     200 from BEFORE the lapse and uncovered the page on its say-so.
 *   - A stalled request (half-open socket on a network handover) never settles,
 *     so the same flag silently stopped every later check until a reload.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/svelte';
import { createRawSnippet, flushSync } from 'svelte';
import type { createKitStub } from './_helpers/kit-runtime-stub.svelte';

const holder = vi.hoisted(() => ({ current: null as ReturnType<typeof createKitStub> | null }));
const nav = vi.hoisted(() => ({ goto: null as unknown as ReturnType<typeof vi.fn> }));

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
vi.mock('$app/navigation', async () => {
	const { vi: v } = await import('vitest');
	nav.goto = v.fn(async () => {});
	return {
		goto: nav.goto,
		invalidate: v.fn(async () => {}),
		invalidateAll: v.fn(async () => {}),
		afterNavigate: (cb: Parameters<ReturnType<typeof createKitStub>['afterNavigate']>[0]) =>
			stub().afterNavigate(cb),
		beforeNavigate: v.fn(),
		replaceState: v.fn(),
		pushState: v.fn(),
		preloadData: v.fn(async () => ({})),
	};
});
vi.mock('$lib/push-subscribe', () => ({ reconcileSubscription: vi.fn(async () => {}) }));
vi.mock('$lib/timezone-sync', () => ({ syncTimeZone: vi.fn(async () => {}) }));
vi.stubGlobal('__APP_VERSION__', '9.9.9');
const store = new Map<string, string>();
vi.stubGlobal('localStorage', {
	getItem: (k: string) => store.get(k) ?? null,
	setItem: (k: string, v: string) => void store.set(k, v),
	removeItem: (k: string) => void store.delete(k),
	clear: () => store.clear(),
});

/** Every lock check the layout makes, settled by hand. */
interface PendingCheck {
	signal: AbortSignal | undefined;
	respond: (status: number) => void;
}
let checks: PendingCheck[] = [];
vi.stubGlobal(
	'fetch',
	vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
		const url = typeof input === 'string' ? input : input.toString();
		if (!url.includes('/api/auth/app-lock')) {
			return Promise.resolve(new Response('{}', { status: 200 }));
		}
		return new Promise<Response>((resolve, reject) => {
			init?.signal?.addEventListener('abort', () =>
				reject(new DOMException('aborted', 'AbortError')),
			);
			checks.push({
				signal: init?.signal ?? undefined,
				respond: (status) => resolve(new Response('{}', { status })),
			});
		});
	}),
);

import AppLayout from '../../src/routes/(app)/+layout.svelte';

const layoutData = {
	user: { id: 'u1', displayName: 'Test', email: 't@e.st', role: 'admin', avatarUrl: null },
	conversations: [],
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
	appLock: { timeoutMs: 60_000, sliding: true },
};

let visibility: DocumentVisibilityState = 'visible';
function setVisibility(v: DocumentVisibilityState) {
	visibility = v;
	document.dispatchEvent(new Event('visibilitychange'));
	flushSync();
}
const covered = () => document.querySelector('.z-app-lock') !== null;
/** Let a settled fetch's continuation run and its state write render. */
async function settle() {
	for (let i = 0; i < 5; i++) await Promise.resolve();
	flushSync();
}

beforeEach(() => {
	vi.useFakeTimers();
	stub().reset();
	checks = [];
	nav.goto.mockClear();
	visibility = 'visible';
	Object.defineProperty(document, 'visibilityState', {
		configurable: true,
		get: () => visibility,
	});
	render(AppLayout, {
		props: {
			data: layoutData as never,
			children: createRawSnippet(() => ({ render: () => '<main>page</main>' })),
		},
	});
	stub().enter();
});
afterEach(() => {
	vi.useRealTimers();
});

describe('app-lock resume check', () => {
	it('covers on hide and uncovers only once the server says the session is still open', async () => {
		setVisibility('hidden');
		expect(covered()).toBe(true);
		setVisibility('visible');
		expect(covered()).toBe(true);
		expect(checks).toHaveLength(1);
		checks[0].respond(200);
		await settle();
		expect(covered()).toBe(false);
	});

	it('goes to /unlock, carrying the current page, when the window has lapsed', async () => {
		setVisibility('hidden');
		setVisibility('visible');
		checks[0].respond(423);
		await settle();
		expect(nav.goto).toHaveBeenCalledWith(expect.stringMatching(/^\/unlock\?from=/), {
			replaceState: true,
		});
		expect(covered()).toBe(true);
	});

	it('a keep-alive in flight across the suspend cannot uncover the page, and does not block the resume check', async () => {
		vi.advanceTimersByTime(20_000); // keep-alive tick
		expect(checks).toHaveLength(1);
		const stale = checks[0];
		setVisibility('hidden');
		expect(stale.signal?.aborted).toBe(true);
		setVisibility('visible');
		// The resume asked afresh rather than deferring to the stale request.
		expect(checks).toHaveLength(2);
		stale.respond(200); // a pre-lapse 200 arriving late
		await settle();
		expect(covered()).toBe(true);
		checks[1].respond(423);
		await settle();
		expect(nav.goto).toHaveBeenCalledOnce();
	});

	it('a stalled check times out instead of stopping every later one', async () => {
		vi.advanceTimersByTime(20_000);
		expect(checks).toHaveLength(1);
		// Never answered: the timeout cuts it off (and its rejection frees the
		// slot on a microtask)...
		vi.advanceTimersByTime(10_000);
		await settle();
		expect(checks[0].signal?.aborted).toBe(true);
		// ...so the next tick still gets to ask.
		vi.advanceTimersByTime(10_000);
		expect(checks).toHaveLength(2);
	});
});
