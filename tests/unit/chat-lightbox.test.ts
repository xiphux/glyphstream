/**
 * Unit tests for the chat page's media lightbox, lifted out of the page.
 *
 * Runs the real runes (the sveltekit() vitest plugin compiles the .svelte.ts
 * module) against a stubbed fan-out controller and `fetch`. The fan-out stub
 * holds only what the lightbox reads: whether a media grid is open, its
 * columns, whether it is mid-pick, and its discard.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const toastError = vi.fn<(message: string) => void>();
vi.mock('#lib/toast.svelte.js', () => ({
	toast: { error: (m: string) => toastError(m) },
}));

import { ChatLightbox } from '#lib/chat-lightbox.svelte.js';
import type { FanoutColumn } from '#lib/fanout.js';
import type { FanoutController } from '#lib/fanout-controller.svelte.js';
import type { MediaListItem } from '#lib/types/api.js';

const item = (id: string, extra: Partial<MediaListItem> = {}) =>
	({ id, origin: 'generated', favorite: false, ...extra }) as MediaListItem;

const column = (branchId: string, mediaIds: string[]) =>
	({
		branchId,
		status: 'done',
		persisted: { parts: mediaIds.map((mediaId) => ({ type: 'image', mediaId })) },
	}) as unknown as FanoutColumn;

/** Route `fetch` by URL: `/api/media/:id` returns that item, the conversation
 *  media list returns `media`. */
function stubFetch(media: string[], overrides: Record<string, () => Promise<Response>> = {}) {
	const mock = vi.fn((url: string, init?: RequestInit) => {
		const key = `${init?.method ?? 'GET'} ${url}`;
		if (overrides[key]) return overrides[key]();
		if (url.endsWith('/media') && url.startsWith('/api/conversations/'))
			return Promise.resolve(Response.json({ items: media.map((id) => ({ id })) }));
		const id = url.split('/').pop()!;
		return Promise.resolve(Response.json(item(id)));
	});
	vi.stubGlobal('fetch', mock);
	return mock;
}

function setup(columns: FanoutColumn[] = []) {
	const page = { conversationId: 'A', error: null as string | null };
	const fanout = {
		isMedia: columns.length > 0,
		columns,
		picking: false,
		discard: vi.fn(async () => true),
	};
	const lb = new ChatLightbox({
		conversationId: () => page.conversationId,
		fanout: fanout as unknown as FanoutController,
		error: () => page.error,
	});
	return { lb, page, fanout };
}

/** Let the fire-and-forget carousel fetch settle. */
const settle = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => toastError.mockReset());
afterEach(() => vi.unstubAllGlobals());

describe('opening', () => {
	it('loads the item and the carousel set', async () => {
		stubFetch(['m1', 'm2']);
		const { lb } = setup();
		await lb.open('m1');
		await settle();
		expect(lb.media?.id).toBe('m1');
		expect(lb.siblings.map((m) => m.id)).toEqual(['m1', 'm2']);
		expect(lb.openingFor).toBeNull();
	});

	it('time-boxes the item fetch, which a later swipe may share with a prefetch', async () => {
		const fetchMock = stubFetch(['m1']);
		const { lb } = setup();
		await lb.open('m1');
		expect(fetchMock).toHaveBeenCalledWith(
			'/api/media/m1',
			expect.objectContaining({ signal: expect.any(AbortSignal) as unknown }),
		);
	});

	it('orders an open grid’s images by the grid, not by completion', async () => {
		stubFetch(['old', 'g2', 'g1']);
		const { lb } = setup([column('b1', ['g1']), column('b2', ['g2'])]);
		await lb.open('g1');
		await settle();
		expect(lb.siblings.map((m) => m.id)).toEqual(['old', 'g1', 'g2']);
	});

	it('drops a carousel set that lands after a conversation switch', async () => {
		stubFetch(['m1']);
		const { lb, page } = setup();
		const opening = lb.open('m1');
		page.conversationId = 'B';
		await opening;
		await settle();
		expect(lb.siblings).toEqual([]);
	});

	it('lets a later tap win over an earlier one still loading', async () => {
		let release!: () => void;
		const slow = new Promise<void>((r) => (release = r));
		stubFetch([], {
			'GET /api/media/m1': async () => {
				await slow;
				return Response.json(item('m1'));
			},
		});
		const { lb } = setup();
		const first = lb.open('m1');
		await lb.open('m2');
		release();
		await first;
		expect(lb.media?.id).toBe('m2');
	});

	it('reset closes and forgets the set', async () => {
		stubFetch(['m1']);
		const { lb } = setup();
		await lb.open('m1');
		await settle();
		lb.reset();
		expect(lb.media).toBeNull();
		expect(lb.siblings).toEqual([]);
	});
});

describe('swiping onto a prefetched slide', () => {
	it('swaps it in synchronously, without fetching it again', async () => {
		const fetchMock = stubFetch(['m1', 'm2']);
		const { lb } = setup();
		await lb.open('m1');
		lb.prefetch('m2');
		await settle();
		const fetchesBefore = fetchMock.mock.calls.length;
		void lb.open('m2');
		// No await: the header has to change in the same frame as the swipe.
		expect(lb.media?.id).toBe('m2');
		expect(fetchMock.mock.calls.length).toBe(fetchesBefore);
	});

	it('drops a slower open still in flight when a cached slide wins', async () => {
		let release!: (r: Response) => void;
		stubFetch(['m1', 'm2', 'm3'], {
			'GET /api/media/m3': () => new Promise((r) => (release = r)),
		});
		const { lb } = setup();
		await lb.open('m1');
		lb.prefetch('m2');
		await settle();
		const slow = lb.open('m3');
		void lb.open('m2');
		release(Response.json(item('m3')));
		await slow;
		expect(lb.media?.id).toBe('m2');
	});

	it('keeps a star toggled on a slide after swiping away and back', async () => {
		stubFetch(['m1', 'm2']);
		const { lb } = setup();
		await lb.open('m1');
		await lb.toggleFavorite('m1', true);
		await lb.open('m2');
		await lb.open('m1');
		expect(lb.media?.favorite).toBe(true);
	});
});

describe('closing', () => {
	it('drops an open still in flight, rather than reopening when it lands', async () => {
		let release!: (r: Response) => void;
		stubFetch(['m1', 'm2'], {
			'GET /api/media/m2': () => new Promise((r) => (release = r)),
		});
		const { lb } = setup();
		await lb.open('m1');
		const swipe = lb.open('m2');
		lb.close();
		release(Response.json(item('m2')));
		await swipe;
		expect(lb.media).toBeNull();
	});
});

describe('favoriting', () => {
	it('reverts the optimistic star when the server refuses', async () => {
		stubFetch([], {
			'PATCH /api/media/m1': () => Promise.resolve(new Response('nope', { status: 500 })),
		});
		const { lb } = setup();
		await lb.open('m1');
		const pending = lb.toggleFavorite('m1', true);
		expect(lb.media?.favorite).toBe(true);
		await pending;
		expect(lb.media?.favorite).toBe(false);
		expect(toastError).toHaveBeenCalled();
		expect(lb.favoritingId).toBeNull();
	});
});

describe('discarding from a fan-out grid', () => {
	it('is offered only for a settled grid image with another column left', async () => {
		stubFetch(['g1', 'g2']);
		const { lb } = setup([column('b1', ['g1']), column('b2', ['g2'])]);
		await lb.open('g1');
		expect(lb.discardable).toBe(true);

		const solo = setup([column('b1', ['g1'])]).lb;
		await solo.open('g1');
		expect(solo.discardable).toBe(false);
	});

	it('discards the branch and moves to the image now in its slot', async () => {
		stubFetch(['g1', 'g2', 'g3']);
		const cols = [column('b1', ['g1']), column('b2', ['g2']), column('b3', ['g3'])];
		const { lb, fanout } = setup(cols);
		await lb.open('g2');
		await settle();
		await lb.discard('g2');
		expect(fanout.discard).toHaveBeenCalledWith(cols[1]);
		expect(lb.siblings.map((m) => m.id)).toEqual(['g1', 'g3']);
		expect(lb.media?.id).toBe('g3');
		expect(lb.deletingId).toBeNull();
	});

	it('toasts the controller’s reason when the discard is refused', async () => {
		stubFetch(['g1', 'g2']);
		const { lb, fanout, page } = setup([column('b1', ['g1']), column('b2', ['g2'])]);
		fanout.discard.mockImplementationOnce(async () => {
			page.error = 'grid busy';
			return false;
		});
		await lb.open('g1');
		await settle();
		await lb.discard('g1');
		expect(toastError).toHaveBeenCalledWith("Couldn't delete: grid busy");
		expect(lb.media?.id).toBe('g1');
	});
});

describe('discarding across a conversation switch', () => {
	it('leaves the next chat’s lightbox alone when the discard lands after a switch', async () => {
		const { lb, page } = setup([column('b1', ['g1']), column('b2', ['g2'])]);
		stubFetch(['g1', 'g2'], {
			'GET /api/conversations/B/media': () =>
				Promise.resolve(Response.json({ items: [{ id: 'x1' }] })),
			// The switch lands while the discard fetches the image to move to — after
			// it has already worked out the old chat's surviving set.
			'GET /api/media/g2': async () => {
				page.conversationId = 'B';
				lb.reset();
				await lb.open('x1');
				await settle();
				return Response.json(item('g2'));
			},
		});
		await lb.open('g1');
		await settle();
		await lb.discard('g1');
		expect(lb.media?.id).toBe('x1');
		expect(lb.siblings.map((m) => m.id)).toEqual(['x1']);
	});
});
