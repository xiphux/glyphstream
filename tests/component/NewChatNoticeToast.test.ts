/* @vitest-environment happy-dom */

/**
 * Holds the line on a `?notice=` announcing itself once.
 *
 * A load function that can't render its page redirects here and names the
 * reason; this page toasts it and strips the param. How it strips decides
 * whether that stays a one-shot. Kit's `replaceState` is the shallow-routing
 * API: it rewrites the address bar while recording the page's REAL url —
 * `?notice=` included — in the history entry, and never updates `page.url`. A
 * Back onto that entry then takes Kit's full popstate path, restoring `page.url`
 * from the entry and dispatching afterNavigate, so the toast fires again — and
 * since the handler re-strips, it re-poisons the entry and repeats on every
 * Back and Forward after that. The user gets an error about a conversation they
 * deleted long ago, on a page whose URL never showed the param.
 *
 * Only a real navigation writes an entry with no recorded url and takes the
 * param off `page.url`. All three spellings look alike at the call site, which
 * is what this pins.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/svelte';
import { flushSync } from 'svelte';
import type { ModelEntry } from '$lib/types/api';
import type { createKitStub } from './_helpers/kit-runtime-stub.svelte';

const holder = vi.hoisted(() => ({ current: null as ReturnType<typeof createKitStub> | null }));

function stub() {
	if (!holder.current) throw new Error('the SvelteKit runtime stub was never built');
	return holder.current;
}

vi.mock('$app/environment', () => ({ browser: true, dev: false, building: false, version: 't' }));
vi.mock('$app/navigation', () => ({
	// The strip is a replacing goto with a `.catch`, so this returns a thenable.
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
	holder.current = createKitStub('http://localhost:3000/?notice=conversation-missing');
	return { page: holder.current.page, navigating: holder.current.navigating };
});

import Harness from './_helpers/NewChatHarness.svelte';
import { goto } from '$app/navigation';
import { toast } from '$lib/toast.svelte';

const model: ModelEntry = {
	id: 'bridge::alpha',
	endpointId: 'bridge',
	upstreamId: 'alpha',
	displayName: 'alpha',
	ownedBy: null,
	kind: 'chat',
	kindKnown: true,
	group: 'Bridge',
	groupKey: 'bridge',
	supportsTools: false,
	contextWindow: null,
	promptStyle: null,
	promptHint: null,
};

const data = {
	user: { id: 'u1', displayName: 'Test', email: 't@e.st', role: 'admin', avatarUrl: null },
	prefs: { enterBehavior: 'send', favoriteModels: [], modelSets: [] },
	models: [model],
	customModels: [],
	defaultModelId: 'bridge::alpha',
	conversations: [],
	generatingIds: [],
	enabledSkills: [],
	featureCategories: [],
	deferredLoaded: true,
	mcpSettled: true,
};

beforeEach(() => {
	// `restoreAllMocks` doesn't touch a bare `vi.fn()`, and the mock is built
	// once per FILE, so the goto assertion could otherwise resolve on an earlier
	// test's call.
	vi.restoreAllMocks();
	vi.mocked(goto).mockClear();
	stub().reset();
	globalThis.fetch = vi.fn(
		async () => new Response(JSON.stringify({ data: [model], endpoint_errors: [] })),
	) as typeof fetch;
});

describe('new-chat page — ?notice= from a redirect', () => {
	it('announces the notice once on arrival', () => {
		const error = vi.spyOn(toast, 'error');
		render(Harness, { props: { data } });
		stub().enter();
		flushSync();
		expect(error).toHaveBeenCalledTimes(1);
		expect(error).toHaveBeenCalledWith('That conversation no longer exists.');
	});

	it('strips the param with a replacing navigation, not a shallow one', async () => {
		render(Harness, { props: { data } });
		stub().enter();
		flushSync();

		await vi.waitFor(() =>
			expect(vi.mocked(goto)).toHaveBeenCalledWith(
				'/',
				expect.objectContaining({ replaceState: true, keepFocus: true }),
			),
		);
	});

	it('keeps other params when it strips', async () => {
		stub().reset('http://localhost:3000/?model=bridge::alpha&notice=conversation-missing');
		render(Harness, { props: { data } });
		stub().enter();
		flushSync();

		await vi.waitFor(() =>
			expect(vi.mocked(goto)).toHaveBeenCalledWith(
				'/?model=bridge%3A%3Aalpha',
				expect.objectContaining({ replaceState: true }),
			),
		);
	});

	it('says nothing for an unrecognized notice value', () => {
		const error = vi.spyOn(toast, 'error');
		stub().reset('http://localhost:3000/?notice=not-a-real-notice');
		render(Harness, { props: { data } });
		stub().enter();
		flushSync();
		expect(error).not.toHaveBeenCalled();
	});
});
