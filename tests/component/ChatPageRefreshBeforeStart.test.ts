/**
 * A page reload between Send and the stream's `start` frame must not render the
 * sent message twice. The server persists the user row before `start`, which
 * waits on the endpoint gate, so a `refreshAll()` while the turn is queued (a
 * return to the tab, coming back online) already swaps the optimistic bubble
 * for that row. A second copy throws `each_key_duplicate` in the keyed message
 * list, which then stops updating: the reply never appears.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render } from '@testing-library/svelte';
import process from 'node:process';
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
	pageData,
	row,
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

describe('chat page — the page load re-runs between Send and `start`', () => {
	it('renders the sent message once, and then the reply', async () => {
		const { body, emit, close } = sseStream();
		vi.stubGlobal(
			'fetch',
			vi.fn(async (input: RequestInfo | URL) => {
				if (fetchUrl(input).includes('/messages')) {
					return { ok: true, status: 200, body } as unknown as Response;
				}
				return new Response('{}', { status: 200 });
			}),
		);
		const errors: string[] = [];
		const onError = (e: ErrorEvent) => {
			errors.push(String((e.error as Error | undefined)?.message ?? e.message));
			e.preventDefault();
		};
		window.addEventListener('error', onError);
		const onRejection = (reason: unknown) =>
			errors.push(reason instanceof Error ? reason.message : String(reason));
		process.on('unhandledRejection', onRejection);

		try {
			const base = [row('u0', 'user', 'first question'), row('a0', 'assistant', 'first answer')];
			const { rerender } = render(Harness, {
				props: { data: pageData(conversation('conv-A', false, base)) },
			});
			stub().enter();
			flushSync();

			await fireEvent.input(box(), { target: { value: 'UNIQUE-SENT-TEXT' } });
			flushSync();
			await fireEvent.keyDown(box(), { key: 'Enter' });
			emit({ type: 'queued', ahead: 1, paused: false });
			await new Promise((r) => setTimeout(r, 20));
			const count = () => document.body.innerHTML.split('UNIQUE-SENT-TEXT').length - 1;
			const before = count();
			expect(before).toBeGreaterThan(0);

			// refreshAll(): same conversation id, a fresh `data.conversation` whose
			// window already holds the persisted user message.
			const u1 = row('u1', 'user', 'UNIQUE-SENT-TEXT');
			await rerender({ data: pageData(conversation('conv-A', false, [...base, u1])) });
			flushSync();
			await new Promise((r) => setTimeout(r, 20));
			expect(count()).toBe(before);

			emit({ type: 'start', userMessage: u1, assistantMessageId: '' });
			await new Promise((r) => setTimeout(r, 30));
			flushSync();
			emit({ type: 'done', assistantMessage: row('a1', 'assistant', 'UNIQUE-REPLY-TEXT') });
			close();
			await new Promise((r) => setTimeout(r, 50));
			flushSync();

			expect(errors).toEqual([]);
			expect(count()).toBe(before);
			expect(document.body.innerHTML).toContain('UNIQUE-REPLY-TEXT');
		} finally {
			window.removeEventListener('error', onError);
			process.off('unhandledRejection', onRejection);
		}
	});
});
