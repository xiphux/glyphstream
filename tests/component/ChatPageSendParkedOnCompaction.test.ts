/**
 * A send parked on auto-compaction must stay with the conversation it was typed
 * in. Mounts the real chat page in conversation A (over the auto-compaction
 * threshold), presses Send, swaps `data` to conversation B while A's compaction
 * still streams (what a sidebar click does to the reused /chat/[id] component),
 * then lets the compaction finish: nothing may be posted to B, and B's restored
 * draft must survive.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render } from '@testing-library/svelte';
import { flushSync } from 'svelte';
import type { createKitStub } from './_helpers/kit-runtime-stub.svelte';

const holder = vi.hoisted(() => ({ current: null as ReturnType<typeof createKitStub> | null }));
function stub() {
	if (!holder.current) throw new Error('no kit stub');
	return holder.current;
}

vi.mock('$app/env', () => ({ browser: true, dev: false, building: false, version: 't' }));
vi.mock('$app/navigation', () => ({
	goto: vi.fn(async () => {}),
	invalidate: vi.fn(async () => {}),
	refreshAll: vi.fn(async () => {}),
	afterNavigate: (cb: Parameters<ReturnType<typeof createKitStub>['afterNavigate']>[0]) =>
		stub().afterNavigate(cb),
	beforeNavigate: vi.fn(),
	pushState: vi.fn(),
	preloadData: vi.fn(async () => ({})),
}));
vi.mock('$app/state', async () => {
	const { createKitStub } = await import('./_helpers/kit-runtime-stub.svelte');
	holder.current = createKitStub('http://localhost:3000/chat/conv-A');
	return { page: holder.current.page, navigating: holder.current.navigating };
});

import Harness from './_helpers/ChatPageHarness.svelte';
import {
	composerBox as box,
	conversation,
	fetchUrl,
	longBranch,
	pageData,
	sseStream,
} from './_helpers/chat-page-fixtures';

const store = new Map<string, string>();
vi.stubGlobal('localStorage', {
	getItem: (k: string) => store.get(k) ?? null,
	setItem: (k: string, v: string) => void store.set(k, v),
	removeItem: (k: string) => void store.delete(k),
	clear: () => store.clear(),
});

beforeEach(() => {
	stub().reset();
	store.clear();
});

describe('chat page — a send parked on auto-compaction, then a conversation switch', () => {
	it("does not post A's text into B, nor wipe B's draft", async () => {
		const { body, emit, close } = sseStream();

		const calls: Array<{ url: string; method: string; body: string | null }> = [];
		vi.stubGlobal(
			'fetch',
			vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
				const url = fetchUrl(input);
				calls.push({
					url,
					method: init?.method ?? 'GET',
					body: typeof init?.body === 'string' ? init.body : null,
				});
				if (url.includes('/compact')) {
					return { ok: true, status: 200, body } as unknown as Response;
				}
				if (url.includes('/messages')) {
					// Never opens: only whether the POST was made matters.
					return new Response('{"error":"test"}', { status: 500 });
				}
				return new Response('{}', { status: 200 });
			}),
		);

		// B has a draft the user left there earlier.
		store.set(
			'glyphstream:composerDraft:conv-B',
			JSON.stringify({ text: 'half-written note in B', savedAt: Date.now() }),
		);

		const convA = conversation('conv-A', true, longBranch());
		const convB = conversation('conv-B', false, []);
		const { rerender } = render(Harness, {
			props: { data: pageData(convA, { autoCompaction: true }) },
		});
		stub().enter();
		flushSync();

		await fireEvent.input(box(), { target: { value: 'a secret typed in private chat A' } });
		flushSync();
		await fireEvent.keyDown(box(), { key: 'Enter' });
		await vi.waitFor(() =>
			expect(calls.some((c) => c.url.includes('/api/conversations/conv-A/compact'))).toBe(true),
		);
		emit({ type: 'compaction_start' });
		emit({ type: 'compaction_text', chunk: 'summary of conversation A' });
		await new Promise((r) => setTimeout(r, 10));
		// Control: the send is parked, nothing posted yet, the text still in the box.
		expect(calls.some((c) => c.url.includes('/messages'))).toBe(false);

		// Sidebar click on B: same component instance, new data.
		await rerender({ data: pageData(convB, { autoCompaction: true }) });
		flushSync();
		await new Promise((r) => setTimeout(r, 10));
		expect(box().value).toBe('half-written note in B');

		emit({ type: 'compaction_done', summaryMessage: { id: 's1', role: 'assistant', parts: [] } });
		close();
		await new Promise((r) => setTimeout(r, 50));

		const posts = calls.filter((c) => c.method === 'POST' && c.url.includes('/messages'));
		expect(posts.map((p) => `${p.url} ${p.body}`)).toEqual([]);
		expect(box().value).toBe('half-written note in B');
	});
});
