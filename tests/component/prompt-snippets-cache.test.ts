/* @vitest-environment happy-dom */

/**
 * The client-side snippet cache's async ordering.
 *
 * Lives under tests/component (not tests/unit) because the module is a
 * `.svelte.ts` using runes — it needs the Svelte compiler and a DOM env.
 *
 * The cases here are all about a load that is ALREADY IN FLIGHT when something
 * else changes the world. Nulling `inflight` doesn't cancel the running
 * promise, so without a generation guard a superseded response commits its
 * stale payload and sets `loaded = true`, pinning the cache for the rest of
 * the session.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ensureSnippetsLoaded, invalidateSnippets, snippetList } from '$lib/prompt-snippets.svelte';
import type { PromptSnippet } from '$lib/types/api';

function snip(name: string): PromptSnippet {
	return {
		id: name,
		name,
		body: `body ${name}`,
		kinds: [],
		tags: [],
		usageCount: 0,
		createdAt: 0,
		updatedAt: 0,
	};
}

/** A fetch stub whose response is released manually, so a load can be held
 *  open across an invalidation. */
function gatedFetch(payload: PromptSnippet[], ok = true) {
	let release!: () => void;
	const gate = new Promise<void>((r) => (release = r));
	const fn = vi.fn(async () => {
		await gate;
		if (!ok) return new Response('nope', { status: 500 });
		return new Response(JSON.stringify({ promptSnippets: payload }), {
			status: 200,
			headers: { 'content-type': 'application/json' },
		});
	});
	return { fn, release };
}

beforeEach(() => {
	invalidateSnippets();
	vi.useRealTimers();
});

afterEach(() => {
	vi.unstubAllGlobals();
	invalidateSnippets();
});

describe('snippet cache — ordinary loading', () => {
	it('loads once and caches', async () => {
		const fetchMock = vi.fn(
			async () =>
				new Response(JSON.stringify({ promptSnippets: [snip('A')] }), {
					status: 200,
					headers: { 'content-type': 'application/json' },
				}),
		);
		vi.stubGlobal('fetch', fetchMock);

		await ensureSnippetsLoaded();
		await ensureSnippetsLoaded();

		expect(snippetList().map((s) => s.name)).toEqual(['A']);
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it('shares one in-flight promise between concurrent callers', async () => {
		const { fn, release } = gatedFetch([snip('A')]);
		vi.stubGlobal('fetch', fn);

		const a = ensureSnippetsLoaded();
		const b = ensureSnippetsLoaded();
		release();
		await Promise.all([a, b]);

		expect(fn).toHaveBeenCalledTimes(1);
	});
});

// Regression: `invalidateSnippets()` nulled `inflight` but could not stop the
// running promise, so a settings-page mutation landing mid-flight was silently
// undone — the composer served the pre-mutation library until a full reload.
describe('snippet cache — invalidation during an in-flight load', () => {
	it('does not let a superseded response overwrite the invalidated cache', async () => {
		const stale = gatedFetch([snip('STALE')]);
		vi.stubGlobal('fetch', stale.fn);

		const pending = ensureSnippetsLoaded();
		invalidateSnippets(); // e.g. the settings page just deleted a snippet
		stale.release();
		await pending;

		expect(snippetList()).toEqual([]);
	});

	it('still refetches afterwards, rather than being pinned as loaded', async () => {
		const stale = gatedFetch([snip('STALE')]);
		vi.stubGlobal('fetch', stale.fn);
		const pending = ensureSnippetsLoaded();
		invalidateSnippets();
		stale.release();
		await pending;

		const fresh = vi.fn(
			async () =>
				new Response(JSON.stringify({ promptSnippets: [snip('FRESH')] }), {
					status: 200,
					headers: { 'content-type': 'application/json' },
				}),
		);
		vi.stubGlobal('fetch', fresh);
		await ensureSnippetsLoaded();

		expect(snippetList().map((s) => s.name)).toEqual(['FRESH']);
		expect(fresh).toHaveBeenCalledTimes(1);
	});

	// A superseded FAILURE must not re-arm the cooldown that the explicit
	// invalidation just cleared, or the composer refuses to reload for 30s
	// right after the user changed their library.
	it('does not re-arm the retry cooldown from a superseded failure', async () => {
		const failing = gatedFetch([], false);
		vi.stubGlobal('fetch', failing.fn);
		const pending = ensureSnippetsLoaded();
		invalidateSnippets();
		failing.release();
		await pending;

		const fresh = vi.fn(
			async () =>
				new Response(JSON.stringify({ promptSnippets: [snip('FRESH')] }), {
					status: 200,
					headers: { 'content-type': 'application/json' },
				}),
		);
		vi.stubGlobal('fetch', fresh);
		await ensureSnippetsLoaded();

		expect(fresh).toHaveBeenCalledTimes(1);
		expect(snippetList().map((s) => s.name)).toEqual(['FRESH']);
	});
});

describe('snippet cache — failure cooldown', () => {
	it('does not retry immediately after a failure', async () => {
		const failing = vi.fn(async () => new Response('nope', { status: 500 }));
		vi.stubGlobal('fetch', failing);

		await ensureSnippetsLoaded();
		await ensureSnippetsLoaded();
		await ensureSnippetsLoaded();

		expect(failing).toHaveBeenCalledTimes(1);
		expect(snippetList()).toEqual([]);
	});

	it('an explicit invalidate clears the cooldown', async () => {
		const failing = vi.fn(async () => new Response('nope', { status: 500 }));
		vi.stubGlobal('fetch', failing);
		await ensureSnippetsLoaded();

		invalidateSnippets();
		await ensureSnippetsLoaded();

		expect(failing).toHaveBeenCalledTimes(2);
	});
});
