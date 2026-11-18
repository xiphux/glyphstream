/**
 * Unit tests for the thread's photos (`ThreadPhotos`): each reply's photo and
 * portrait views, the version shown ahead of the server, the light photo read
 * that patches replies and the face, the lost-draw guess, and the watch — with
 * every read pinned to the conversation it started in.
 *
 * Real runes (the sveltekit() vitest plugin compiles the .svelte.ts module);
 * the draw dialog is a stub, the watch a recorded call.
 */
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

const watch = vi.hoisted(() => ({
	start: vi.fn(),
	stop: vi.fn(),
}));
vi.mock('#lib/photo-develop-watch.js', () => ({
	watchDevelopingPhotos: (w: unknown) => {
		watch.start(w);
		return watch.stop;
	},
}));

import { ThreadPhotos, type PhotoDraws } from '#lib/thread-photos.svelte.js';
import type { DevelopWatch } from '#lib/photo-develop-watch.js';
import type {
	ChatMessage,
	DevelopingImage,
	MessageImage,
	PhotoStateResponse,
} from '#lib/types/api.js';

function image(id: string, over: Partial<MessageImage> = {}): MessageImage {
	return {
		id,
		kind: 'photo',
		markerIndex: 0,
		mediaId: `m-${id}`,
		error: null,
		inComparison: false,
		modelId: 'img-1',
		shown: false,
		aspectRatio: null,
		width: null,
		height: null,
		createdAt: 0,
		...over,
	};
}
const portrait = (id: string, over: Partial<MessageImage> = {}) =>
	image(id, { kind: 'portrait', markerIndex: null, ...over });

const drawing = (over: Partial<DevelopingImage> = {}): DevelopingImage => ({
	kind: 'photo',
	markerIndex: 0,
	modelId: 'img-1',
	compareId: null,
	...over,
});

const reply = (id: string, over: Partial<ChatMessage> = {}) =>
	({
		id,
		role: 'assistant',
		parentMessageId: null,
		parts: [{ type: 'text', text: 'hi\n\n[photo: a fox]\n\n[photo: a hen]' }],
		...over,
	}) as ChatMessage;

function setup(
	opts: { messages?: ChatMessage[]; photosOn?: boolean; hasImageModel?: boolean } = {},
) {
	const page = {
		convId: 'A',
		messages: opts.messages ?? [reply('r1')],
		loaded: { id: 'A', avatarMediaId: 'face-0' as string | null, photos: opts.photosOn ?? true },
	};
	const draws = {
		developingFor: vi.fn(() => new Set<number>()),
		isDeveloping: vi.fn(() => false),
		showPhoto: vi.fn(async () => {}),
		removePhoto: vi.fn(async () => true),
		openDialog: vi.fn(),
		openPhotoDialog: vi.fn(),
	};
	const photos = new ThreadPhotos({
		convId: () => page.convId,
		messages: () => page.messages,
		setMessages: (next) => (page.messages = next),
		loaded: () => page.loaded,
		hasImageModel: () => opts.hasImageModel ?? true,
		draws: () => draws as unknown as PhotoDraws,
	});
	return { photos, page, draws };
}

const state = (
	replies: PhotoStateResponse['replies'],
	avatarMediaId: string | null = null,
): PhotoStateResponse => ({
	developing: Object.values(replies).reduce((n, r) => n + r.developing.length, 0),
	avatarMediaId,
	replies,
});

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
	watch.start.mockReset();
	watch.stop.mockReset();
	fetchMock = vi.fn(async () => Response.json(state({})));
	vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe('a reply’s photos', () => {
	it('are none in a chat that does not send photos, or on a user row', () => {
		expect(setup({ photosOn: false }).photos.photosFor(reply('r1'), 'Sam')).toBeUndefined();
		const user = { ...reply('u1'), role: 'user' } as ChatMessage;
		expect(setup().photos.photosFor(user, 'Sam')).toBeUndefined();
	});

	it('groups versions by marker, leaving portraits out', () => {
		const images = [image('a'), image('b', { markerIndex: 1 }), image('c'), portrait('p')];
		const view = setup().photos.photosFor(reply('r1', { images }), 'Sam')!;
		expect([...view.versions.keys()]).toEqual([0, 1]);
		expect(view.versions.get(0)!.map((v) => v.id)).toEqual(['a', 'c']);
	});

	it('counts this tab’s draws and the server’s as developing', () => {
		const { photos, draws } = setup();
		draws.developingFor.mockReturnValue(new Set([1]));
		const view = photos.photosFor(reply('r1', { developing: [drawing()] }), 'Sam')!;
		expect(view.developing).toEqual(new Set([0, 1]));
	});

	it('opens the develop dialog on the marker’s description', () => {
		const { photos, draws } = setup();
		photos.photosFor(reply('r1'), 'Sam')!.onDevelop!(1);
		expect(draws.openPhotoDialog).toHaveBeenCalledWith({ replyId: 'r1', index: 1 }, 'a hen');
	});

	it('says there is no image model rather than offer Develop', () => {
		const view = setup({ hasImageModel: false }).photos.photosFor(reply('r1'), 'Sam')!;
		expect(view.onDevelop).toBeUndefined();
		expect(view.noImageModel).toBe(true);
	});

	it('hands a switch or a removal to the draw dialog', () => {
		const { photos, draws } = setup();
		const view = photos.photosFor(reply('r1'), 'Sam')!;
		view.onShow!(image('a'));
		view.onRemove!(image('a'));
		expect(draws.showPhoto).toHaveBeenCalledWith('r1', image('a'));
		expect(draws.removePhoto).toHaveBeenCalledWith('r1', image('a'));
	});
});

describe('a reply’s portrait', () => {
	it('is none where nothing is drawn or drawing', () => {
		expect(setup().photos.portraitFor(reply('r1'))).toBeUndefined();
	});

	it('shows in any chat, and draws again from its reply', () => {
		const { photos, draws } = setup({ photosOn: false });
		const m = reply('r1', { images: [portrait('p', { shown: true }), image('a')] });
		const view = photos.portraitFor(m)!;
		expect(view.versions.get(0)!.map((v) => v.id)).toEqual(['p']);
		view.onDevelop!(0);
		expect(draws.openDialog).toHaveBeenCalledWith(m);
	});

	it('is drawing on this tab’s word or the server’s', () => {
		const { photos, draws } = setup();
		expect(
			photos.portraitFor(
				reply('r1', { developing: [drawing({ kind: 'portrait', markerIndex: null })] }),
			)!.developing,
		).toEqual(new Set([0]));
		draws.isDeveloping.mockReturnValue(true);
		expect(photos.portraitFor(reply('r1'))!.developing).toEqual(new Set([0]));
	});
});

describe('a version shown ahead of the server', () => {
	const two = () => reply('r1', { images: [image('a', { shown: true }), image('b')] });
	const shownIds = (p: ThreadPhotos) =>
		p
			.photosFor(two(), 'Sam')!
			.versions.get(0)!
			.filter((v) => v.shown)
			.map((v) => v.id);

	it('shows at once, over the data', () => {
		const { photos } = setup();
		photos.showAhead('r1', 0, 'b');
		expect(photos.shownVersion('r1', 0)).toBe('b');
		expect(shownIds(photos)).toEqual(['b']);
	});

	it('goes back on undo, unless a later switch moved on', () => {
		const { photos } = setup();
		const undoB = photos.showAhead('r1', 0, 'b');
		undoB();
		expect(photos.shownVersion('r1', 0)).toBeUndefined();

		const undoA = photos.showAhead('r1', 0, 'a');
		photos.showAhead('r1', 0, 'b');
		undoA();
		expect(photos.shownVersion('r1', 0)).toBe('b');
	});

	it('restores the earlier switch on undo', () => {
		const { photos } = setup();
		photos.showAhead('r1', 0, 'a');
		photos.showAhead('r1', 0, 'b')();
		expect(photos.shownVersion('r1', 0)).toBe('a');
	});

	it('is ignored for a version with no image', () => {
		const { photos } = setup();
		const m = reply('r1', { images: [image('a', { shown: true }), image('x', { mediaId: null })] });
		photos.showAhead('r1', 0, 'x');
		expect(
			photos
				.photosFor(m, 'Sam')!
				.versions.get(0)!
				.find((v) => v.shown)?.id,
		).toBe('a');
	});

	it('applies to a portrait too', () => {
		const { photos } = setup();
		photos.showAhead('r1', null, 'q');
		const m = reply('r1', { images: [portrait('p', { shown: true }), portrait('q')] });
		expect(
			photos
				.portraitFor(m)!
				.versions.get(0)!
				.find((v) => v.shown)?.id,
		).toBe('q');
	});

	it('is dropped by forgetShown and by a conversation switch', () => {
		const { photos } = setup();
		photos.showAhead('r1', 0, 'b');
		photos.forgetShown('r1', 0);
		expect(photos.shownVersion('r1', 0)).toBeUndefined();
		photos.showAhead('r1', 1, 'b');
		photos.reset();
		expect(photos.shownVersion('r1', 1)).toBeUndefined();
	});
});

describe('the light photo read', () => {
	it('patches only the replies it names, emptying what is gone', () => {
		const other = reply('r2', { images: [image('z')] });
		const { photos, page } = setup({
			messages: [reply('r1', { images: [image('a')], developing: [drawing()] }), other],
		});
		photos.apply(state({ r1: { images: [], developing: [] } }));
		expect(page.messages[0].images).toBeUndefined();
		expect(page.messages[0].developing).toBeUndefined();
		expect(page.messages[1]).toBe(other);
	});

	it('takes the face it reports, until the load runs again', () => {
		const { photos, page } = setup();
		expect(photos.avatarMediaId).toBe('face-0');
		photos.apply(state({}, 'face-1'));
		expect(photos.avatarMediaId).toBe('face-1');
		photos.apply(state({}, null));
		expect(photos.avatarMediaId).toBeNull();
		photos.forgetFace();
		expect(photos.avatarMediaId).toBe('face-0');

		// The read's face is the conversation's it was read in.
		photos.apply(state({}, 'face-1'));
		page.loaded = { id: 'B', avatarMediaId: 'face-B', photos: true };
		expect(photos.avatarMediaId).toBe('face-B');
	});

	it('asks for just those replies, and applies the answer', async () => {
		const { photos, page } = setup();
		fetchMock.mockResolvedValueOnce(
			Response.json(state({ r1: { images: [image('a')], developing: [] } }, 'face-1')),
		);
		expect(await photos.refresh(['r1', 'r2'])).toBe(true);
		expect(fetchMock.mock.calls[0][0]).toBe('/api/conversations/A/photos?messages=r1,r2');
		expect(page.messages[0].images?.map((i) => i.id)).toEqual(['a']);
		expect(photos.avatarMediaId).toBe('face-1');
	});

	it('drops an answer that lands after a switch', async () => {
		const { photos, page } = setup();
		let release!: (r: Response) => void;
		fetchMock.mockReturnValueOnce(new Promise<Response>((r) => (release = r)));
		const read = photos.refresh(['r1']);
		page.convId = 'B';
		page.loaded = { id: 'B', avatarMediaId: null, photos: true };
		release(Response.json(state({ r1: { images: [image('a')], developing: [] } }, 'face-A')));
		expect(await read).toBe(false);
		expect(page.messages[0].images).toBeUndefined();
		expect(photos.avatarMediaId).toBeNull();
	});

	it('is false when refused or unreachable', async () => {
		const { photos } = setup();
		fetchMock.mockResolvedValueOnce(new Response('{}', { status: 500 }));
		expect(await photos.refresh(['r1'])).toBe(false);
		fetchMock.mockRejectedValueOnce(new TypeError('offline'));
		expect(await photos.refresh(['r1'])).toBe(false);
	});
});

describe('a draw that has ended', () => {
	const lost = drawing({ modelId: 'img-2' });

	it('takes the server’s word where there is one', async () => {
		const { photos, page } = setup();
		await photos.drawEnded('r1', lost);
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(page.messages[0].developing).toBeUndefined();
	});

	it('counts a lost draw on its reply where the server can’t be asked', async () => {
		const { photos, page } = setup();
		fetchMock.mockRejectedValue(new TypeError('offline'));
		await photos.drawEnded('r1', lost);
		expect(page.messages[0].developing).toEqual([lost]);
		// Not one whose stream ended on the server's word.
		await photos.drawEnded('r1', null);
		expect(page.messages[0].developing).toEqual([lost]);
	});

	it('doesn’t count a lost draw the reply already lists', async () => {
		const { photos, page } = setup({ messages: [reply('r1', { developing: [lost] })] });
		fetchMock.mockRejectedValue(new TypeError('offline'));
		await photos.drawEnded('r1', lost);
		expect(page.messages[0].developing).toEqual([lost]);
		// A second lost draw of the same model is another draw.
		await photos.drawEnded('r1', lost);
		expect(page.messages[0].developing).toEqual([lost, lost]);
	});

	it('starts counting afresh once the server has had its word', async () => {
		const { photos, page } = setup({ messages: [reply('r1', { developing: [lost] })] });
		fetchMock.mockRejectedValueOnce(new TypeError('offline'));
		await photos.drawEnded('r1', lost);
		// The server's word, still listing the draw: the guess so far is spent.
		fetchMock.mockResolvedValueOnce(
			Response.json(state({ r1: { images: [], developing: [lost] } })),
		);
		await photos.drawEnded('r1', null);
		fetchMock.mockRejectedValueOnce(new TypeError('offline'));
		await photos.drawEnded('r1', lost);
		expect(page.messages[0].developing).toEqual([lost]);
	});

	it('guesses nothing once the page has moved to another conversation', async () => {
		const { photos, page } = setup();
		fetchMock.mockImplementationOnce(async () => {
			page.convId = 'B';
			throw new TypeError('offline');
		});
		await photos.drawEnded('r1', lost);
		expect(page.messages[0].developing).toBeUndefined();
	});
});

describe('the develop watch', () => {
	it('is not started while nothing is developing', () => {
		expect(setup().photos.watch()).toBeUndefined();
		expect(watch.start).not.toHaveBeenCalled();
	});

	it('watches the developing replies, expecting their draws, and returns its stop', () => {
		const { photos } = setup({
			messages: [
				reply('r1', { developing: [drawing(), drawing({ markerIndex: 1 })] }),
				reply('r2'),
				reply('r3', { developing: [drawing()] }),
			],
		});
		expect(photos.watch()).toBe(watch.stop);
		const arg = watch.start.mock.calls[0][0] as DevelopWatch;
		expect(arg).toMatchObject({ conversationId: 'A', replyIds: ['r1', 'r3'], expected: 3 });
	});

	it('applies what it hears, but not after a switch', () => {
		const { photos, page } = setup({ messages: [reply('r1', { developing: [drawing()] })] });
		photos.watch();
		const arg = watch.start.mock.calls[0][0] as DevelopWatch;
		arg.apply(state({ r1: { images: [image('a')], developing: [] } }, 'face-1'));
		expect(page.messages[0].images?.map((i) => i.id)).toEqual(['a']);

		page.convId = 'B';
		arg.apply(state({ r1: { images: [], developing: [] } }, 'face-A'));
		expect(page.messages[0].images?.map((i) => i.id)).toEqual(['a']);
		expect(photos.avatarMediaId).toBe('face-1');
	});
});
