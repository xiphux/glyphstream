/**
 * The thread's photos, through the real chat page: what each reply's photo and
 * portrait slots show, the version switch that shows ahead of the server, the
 * light photo read (`GET …/photos?messages=`) that patches replies and the
 * face in place, the develop watch, and the guards that keep a read started in
 * one conversation from landing in the next.
 *
 * The page is reused across a /chat/A -> /chat/B navigation, so a response
 * that outlives the switch is the case to pin: applied, it would dress B in
 * A's face.
 */
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
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
import { conversation, fetchUrl, pageData, row } from './_helpers/chat-page-fixtures';
import type { DevelopingImage, MessageImage, PhotoStateResponse } from '#lib/types/api.js';

const store = new Map<string, string>();
vi.stubGlobal('localStorage', {
	getItem: (k: string) => store.get(k) ?? null,
	setItem: (k: string, v: string) => void store.set(k, v),
	removeItem: (k: string) => void store.delete(k),
	clear: () => store.clear(),
});

function image(id: string, over: Partial<MessageImage> = {}): MessageImage {
	return {
		id,
		kind: 'photo',
		markerIndex: 0,
		mediaId: `m-${id}`,
		error: null,
		inComparison: false,
		modelId: 'img::one',
		shown: false,
		aspectRatio: null,
		width: null,
		height: null,
		createdAt: 1,
		...over,
	};
}

const drawing = (over: Partial<DevelopingImage> = {}): DevelopingImage => ({
	kind: 'photo',
	markerIndex: 0,
	modelId: 'img::one',
	compareId: null,
	...over,
});

/** A reply that sent one photo, with these versions and draws out. */
function photoReply(id: string, images?: MessageImage[], developing?: DevelopingImage[]) {
	return {
		...row(id, 'assistant', 'Look at this\n\n[photo: a red fox in the snow]\n\nNice, right?'),
		...(images ? { images } : {}),
		...(developing ? { developing } : {}),
	};
}

/** Page data for a photos-on chat holding these rows. */
function photoChat(
	id: string,
	messages: unknown[],
	opts: { hasImageModel?: boolean; avatarMediaId?: string | null } = {},
) {
	const data = pageData({
		...conversation(id, false, [row(`${id}-u`, 'user', 'send me a photo'), ...messages]),
		photos: true,
		avatarMediaId: opts.avatarMediaId ?? null,
	} as unknown as ReturnType<typeof conversation>);
	return { ...data, hasImageModel: opts.hasImageModel ?? true };
}

function state(
	replies: PhotoStateResponse['replies'],
	avatarMediaId: string | null = null,
): PhotoStateResponse {
	const developing = Object.values(replies).reduce((n, r) => n + r.developing.length, 0);
	return { developing, avatarMediaId, replies };
}

const json = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), {
		status,
		headers: { 'Content-Type': 'application/json' },
	});

/** A response the test releases when it likes. */
function deferred() {
	let release!: (r: Response) => void;
	const promise = new Promise<Response>((r) => (release = r));
	return { promise, release };
}

type Route = (url: string, init?: RequestInit) => Response | Promise<Response> | undefined;
let routes: Route[];
let calls: Array<{ url: string; method: string }>;

beforeEach(() => {
	stub().reset();
	store.clear();
	routes = [];
	calls = [];
	vi.stubGlobal(
		'fetch',
		vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = fetchUrl(input);
			calls.push({ url, method: init?.method ?? 'GET' });
			for (const r of routes) {
				const res = r(url, init);
				if (res) return res;
			}
			return json({});
		}),
	);
});
afterEach(() => {
	vi.useRealTimers();
});

const settle = async (ms = 20) => {
	await new Promise((r) => setTimeout(r, ms));
	flushSync();
};

function mount(data: ReturnType<typeof photoChat>) {
	const view = render(Harness, { props: { data } });
	stub().enter();
	flushSync();
	return view;
}

const photoReads = () =>
	calls.filter((c) => c.method === 'GET' && /\/photos\?messages=/.test(c.url));
const button = (name: string) =>
	[...document.querySelectorAll('button')].find(
		(b) => b.getAttribute('aria-label') === name || b.textContent?.trim() === name,
	);
const shownSrc = () =>
	document.querySelector<HTMLImageElement>('img[alt="a red fox in the snow"]')?.getAttribute('src');
const faces = () =>
	[...document.querySelectorAll<HTMLImageElement>('img[src$="/thumbnail"]')].map((i) =>
		i.getAttribute('src'),
	);

describe('chat page — a reply’s photo slot', () => {
	it('offers Develop for a photo not yet developed', () => {
		mount(photoChat('conv-A', [photoReply('a1')]));
		expect(document.body.textContent).toContain('a red fox in the snow');
		expect(button('Develop')).toBeTruthy();
	});

	it('says why there is no Develop where no image model is configured', () => {
		mount(photoChat('conv-A', [photoReply('a1')], { hasImageModel: false }));
		expect(button('Develop')).toBeUndefined();
		expect(document.body.textContent).toContain('No image model is configured to develop it.');
	});

	it('shows no photo slot in a chat that does not send photos', () => {
		const data = photoChat('conv-A', [photoReply('a1')]);
		data.conversation.photos = false as never;
		mount(data);
		expect(button('Develop')).toBeUndefined();
	});

	it('shows the version on show, and says a draw the server reports is developing', () => {
		mount(
			photoChat('conv-A', [
				photoReply('a1', [image('v1', { shown: true }), image('v2')], [drawing()]),
			]),
		);
		expect(shownSrc()).toBe('/api/media/m-v1/display');
		expect(document.body.textContent).toContain('1/2');
		expect(document.body.textContent).toContain('Developing…');
		// A draw under way leaves nothing to develop again until it lands.
		expect(button('Develop again')).toBeUndefined();
	});
});

describe('chat page — switching a photo’s version', () => {
	it('shows the next version at once and asks the server to keep it', async () => {
		const patch = deferred();
		routes.push((url, init) => (init?.method === 'PATCH' ? patch.promise : undefined));
		mount(photoChat('conv-A', [photoReply('a1', [image('v1', { shown: true }), image('v2')])]));

		await fireEvent.click(button('Next version')!);
		flushSync();
		expect(shownSrc()).toBe('/api/media/m-v2/display');
		expect(document.body.textContent).toContain('2/2');
		expect(calls).toContainEqual({
			url: '/api/conversations/conv-A/photos/v2',
			method: 'PATCH',
		});

		patch.release(json({}));
		await settle();
		expect(shownSrc()).toBe('/api/media/m-v2/display');
		// A photo's version needs no read of the server: nothing else shows it.
		expect(photoReads()).toEqual([]);
	});

	it('goes back to what was showing when the server refuses', async () => {
		routes.push((url, init) =>
			init?.method === 'PATCH' ? json({ message: 'nope' }, 500) : undefined,
		);
		mount(photoChat('conv-A', [photoReply('a1', [image('v1', { shown: true }), image('v2')])]));

		await fireEvent.click(button('Next version')!);
		await settle();
		expect(shownSrc()).toBe('/api/media/m-v1/display');
		expect(document.body.textContent).toContain('1/2');
	});

	it('forgets a switch made here when the conversation changes', async () => {
		routes.push((url, init) => (init?.method === 'PATCH' ? json({}) : undefined));
		const reply = photoReply('a1', [image('v1', { shown: true }), image('v2')]);
		const { rerender } = mount(photoChat('conv-A', [reply]));
		await fireEvent.click(button('Next version')!);
		await settle();
		expect(shownSrc()).toBe('/api/media/m-v2/display');

		// Navigate away and back: the load's word, not this tab's earlier switch.
		await rerender({ data: photoChat('conv-B', [photoReply('b1')]) });
		flushSync();
		await rerender({ data: photoChat('conv-A', [reply]) });
		flushSync();
		expect(shownSrc()).toBe('/api/media/m-v1/display');
	});
});

describe('chat page — removing a photo', () => {
	it('trashes the image, then patches the reply from the light read', async () => {
		routes.push((url, init) => {
			if (init?.method === 'DELETE') return json({});
			if (url.includes('/photos?messages=a1')) {
				return json(state({ a1: { images: [image('v2', { shown: true })], developing: [] } }));
			}
		});
		mount(photoChat('conv-A', [photoReply('a1', [image('v1', { shown: true }), image('v2')])]));

		await fireEvent.click(button('Remove this photo')!);
		await settle();
		expect(calls).toContainEqual({ url: '/api/media/m-v1', method: 'DELETE' });
		expect(photoReads().map((c) => c.url)).toEqual([
			'/api/conversations/conv-A/photos?messages=a1',
		]);
		expect(shownSrc()).toBe('/api/media/m-v2/display');
		expect(document.body.textContent).not.toContain('1/2');
	});

	it('takes the reply off its photo when the read says none is left', async () => {
		routes.push((url, init) => {
			if (init?.method === 'DELETE') return json({});
			if (url.includes('/photos?messages=a1')) {
				return json(state({ a1: { images: [], developing: [] } }));
			}
		});
		mount(photoChat('conv-A', [photoReply('a1', [image('v1', { shown: true })])]));

		await fireEvent.click(button('Remove this photo')!);
		await settle();
		expect(shownSrc()).toBeUndefined();
		expect(button('Develop')).toBeTruthy();
	});

	it('drops a read that lands after a switch to another conversation', async () => {
		const read = deferred();
		routes.push((url, init) => {
			if (init?.method === 'DELETE') return json({});
			if (url.includes('/conv-A/photos?messages=')) return read.promise;
		});
		const { rerender } = mount(
			photoChat('conv-A', [photoReply('a1', [image('v1', { shown: true })])]),
		);
		await fireEvent.click(button('Remove this photo')!);
		await settle();
		expect(photoReads()).toHaveLength(1);

		// conv-B happens to hold a reply with the same id: only the guard stands
		// between it and conv-A's answer.
		await rerender({
			data: photoChat('conv-B', [photoReply('a1', [image('b1', { shown: true })])]),
		});
		flushSync();
		read.release(json(state({ a1: { images: [], developing: [] } }, 'face-A')));
		await settle();
		expect(shownSrc()).toBe('/api/media/m-b1/display');
		expect(faces()).not.toContain('/api/media/face-A/thumbnail');
	});
});

describe('chat page — a portrait', () => {
	const portrait = (id: string, over: Partial<MessageImage> = {}) =>
		image(id, { kind: 'portrait', markerIndex: null, ...over });

	it('wears the face the light read reports once a portrait goes on show', async () => {
		routes.push((url, init) => {
			if (init?.method === 'PATCH') return json({});
			if (url.includes('/photos?messages=a1')) {
				return json(
					state(
						{
							a1: {
								images: [portrait('p1'), portrait('p2', { shown: true })],
								developing: [],
							},
						},
						'm-p2',
					),
				);
			}
		});
		const load = () =>
			photoChat(
				'conv-A',
				[
					{
						...row('a1', 'assistant', 'hello'),
						images: [portrait('p1', { shown: true }), portrait('p2')],
					},
				],
				{ avatarMediaId: 'm-p1' },
			);
		const { rerender } = mount(load());
		expect(faces()).toContain('/api/media/m-p1/thumbnail');

		await fireEvent.click(button('Next version')!);
		await settle();
		expect(calls).toContainEqual({ url: '/api/conversations/conv-A/photos/p2', method: 'PATCH' });
		expect(photoReads().map((c) => c.url)).toEqual([
			'/api/conversations/conv-A/photos?messages=a1',
		]);
		expect(faces()).toContain('/api/media/m-p2/thumbnail');
		expect(faces()).not.toContain('/api/media/m-p1/thumbnail');

		// The load running again has the last word on the face.
		await rerender({ data: load() });
		flushSync();
		expect(faces()).toContain('/api/media/m-p1/thumbnail');
	});

	it('shows a portrait the server reports drawing, on any chat', () => {
		const data = photoChat('conv-A', [
			{
				...row('a1', 'assistant', 'hello'),
				developing: [drawing({ kind: 'portrait', markerIndex: null })],
			},
		]);
		data.conversation.photos = false as never;
		mount(data);
		expect(document.body.textContent).toContain('Portrait');
		expect(document.body.textContent).toContain('Drawing…');
	});
});

describe('chat page — the develop watch', () => {
	it('asks after developing photos and patches the reply when one lands', async () => {
		routes.push((url) =>
			url.includes('/photos?messages=a1')
				? json(state({ a1: { images: [image('v1', { shown: true })], developing: [] } }))
				: undefined,
		);
		mount(photoChat('conv-A', [photoReply('a1', undefined, [drawing()])]));
		expect(document.body.textContent).toContain('Developing…');

		document.dispatchEvent(new Event('visibilitychange'));
		await settle();
		expect(photoReads().map((c) => c.url)).toEqual([
			'/api/conversations/conv-A/photos?messages=a1',
		]);
		expect(shownSrc()).toBe('/api/media/m-v1/display');
		expect(document.body.textContent).not.toContain('Developing…');

		// Nothing developing now: the watch is retired.
		document.dispatchEvent(new Event('visibilitychange'));
		await settle();
		expect(photoReads()).toHaveLength(1);
	});

	it('polls while visible', async () => {
		vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
		mount(photoChat('conv-A', [photoReply('a1', undefined, [drawing()])]));
		expect(photoReads()).toEqual([]);
		vi.advanceTimersByTime(5_000);
		await settle();
		expect(photoReads()).toHaveLength(1);
	});

	it('leaves the reply alone while the server says it is still developing', async () => {
		routes.push((url) =>
			url.includes('/photos?messages=a1')
				? json(state({ a1: { images: [image('v9', { shown: true })], developing: [drawing()] } }))
				: undefined,
		);
		mount(photoChat('conv-A', [photoReply('a1', undefined, [drawing()])]));
		document.dispatchEvent(new Event('visibilitychange'));
		await settle();
		expect(photoReads()).toHaveLength(1);
		// Same count out as the page has: not news.
		expect(shownSrc()).toBeUndefined();
		expect(document.body.textContent).toContain('Developing…');
	});

	it('watches the next conversation’s replies, not the last one’s, after a switch', async () => {
		const read = deferred();
		routes.push((url) => {
			if (url.includes('/conv-A/photos?messages=')) return read.promise;
			if (url.includes('/conv-B/photos?messages=b1')) {
				return json(state({ b1: { images: [], developing: [drawing()] } }));
			}
		});
		const { rerender } = mount(photoChat('conv-A', [photoReply('a1', undefined, [drawing()])]));
		document.dispatchEvent(new Event('visibilitychange'));
		await settle();
		expect(photoReads().map((c) => c.url)).toEqual([
			'/api/conversations/conv-A/photos?messages=a1',
		]);

		await rerender({
			data: photoChat('conv-B', [photoReply('a1'), photoReply('b1', undefined, [drawing()])]),
		});
		flushSync();
		// conv-A's answer, landing late, must not reach conv-B — not its reply
		// of the same id, and not its face.
		read.release(
			json(state({ a1: { images: [image('va', { shown: true })], developing: [] } }, 'face-A')),
		);
		await settle();
		expect(shownSrc()).toBeUndefined();
		expect(faces()).not.toContain('/api/media/face-A/thumbnail');

		document.dispatchEvent(new Event('visibilitychange'));
		await settle();
		expect(photoReads().map((c) => c.url)).toEqual([
			'/api/conversations/conv-A/photos?messages=a1',
			'/api/conversations/conv-B/photos?messages=b1',
		]);
	});
});
