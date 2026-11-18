/**
 * A fan-out the server refuses at /prepare must leave the composer as it was:
 * the prompt, its attachments and the compare cart. Nothing was persisted, so
 * clearing them up front lost the text with nothing on the thread to show
 * for it. And a prepared one clears only what it sent, not a next message
 * typed while /prepare was out.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { flushSync, tick } from 'svelte';
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

describe('chat page — a fan-out refused at /prepare', () => {
	it('keeps the prompt and the compare cart', async () => {
		const posts: string[] = [];
		vi.stubGlobal(
			'fetch',
			vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
				const url = fetchUrl(input);
				if (init?.method === 'POST') posts.push(url);
				if (url.includes('/messages/prepare')) {
					return new Response(JSON.stringify({ message: 'Too many generations' }), {
						status: 429,
						headers: { 'Content-Type': 'application/json' },
					});
				}
				return new Response('{}', { status: 200 });
			}),
		);
		const user = userEvent.setup();
		const base = [row('u0', 'user', 'first question'), row('a0', 'assistant', 'first answer')];
		render(Harness, { props: { data: pageData(conversation('conv-A', false, base)) } });
		stub().enter();
		flushSync();

		// Compare the one model against itself: two branches.
		await user.click(screen.getByLabelText('Select model'));
		await user.click(screen.getByText('Multiple'));
		await user.click(screen.getByRole('option', { name: /alpha/ }));
		await tick();
		await user.keyboard('{Escape}');
		await tick();
		expect(screen.getByText('2 models')).toBeInTheDocument();

		await fireEvent.input(box(), { target: { value: 'compare these' } });
		flushSync();
		await fireEvent.keyDown(box(), { key: 'Enter' });
		await vi.waitFor(() => expect(posts).toEqual(['/api/conversations/conv-A/messages/prepare']));
		await new Promise((r) => setTimeout(r, 20));
		flushSync();

		expect(box().value).toBe('compare these');
		expect(screen.getByText('2 models')).toBeInTheDocument();
		expect(document.body.textContent).toContain('Too many generations');
	});

	it('a message typed while /prepare is out survives the prepared fan-out clearing the box', async () => {
		let releasePrepare!: () => void;
		vi.stubGlobal(
			'fetch',
			vi.fn(async (input: RequestInfo | URL) => {
				const url = fetchUrl(input);
				if (url.includes('/messages/prepare')) {
					await new Promise<void>((r) => (releasePrepare = r));
					return Response.json({ userMessage: row('u1', 'user', 'compare these') });
				}
				return new Response('{}', { status: 500 });
			}),
		);
		const user = userEvent.setup();
		const base = [row('u0', 'user', 'first question'), row('a0', 'assistant', 'first answer')];
		render(Harness, { props: { data: pageData(conversation('conv-A', false, base)) } });
		stub().enter();
		flushSync();

		await user.click(screen.getByLabelText('Select model'));
		await user.click(screen.getByText('Multiple'));
		await user.click(screen.getByRole('option', { name: /alpha/ }));
		await tick();
		await user.keyboard('{Escape}');
		await tick();

		await fireEvent.input(box(), { target: { value: 'compare these' } });
		flushSync();
		await fireEvent.keyDown(box(), { key: 'Enter' });
		await vi.waitFor(() => expect(releasePrepare).toBeDefined());

		await fireEvent.input(box(), { target: { value: 'and a follow-up' } });
		flushSync();
		releasePrepare();
		await new Promise((r) => setTimeout(r, 20));
		flushSync();

		expect(box().value).toBe('and a follow-up');
	});
});
