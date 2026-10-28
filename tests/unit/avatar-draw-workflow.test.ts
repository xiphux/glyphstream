/**
 * Unit tests for the draw dialog's workflow — avatar portraits and texting
 * photos — lifted out of the chat page.
 *
 * The workflow runs its real runes (the sveltekit() vitest plugin compiles the
 * .svelte.ts module). The catalogue is a stub list, and the page's photo
 * refresh a recorded call.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const toasts = vi.hoisted(() => ({ error: vi.fn() }));
vi.mock('#lib/toast.svelte.js', () => ({ toast: { success: () => {}, error: toasts.error } }));

import { AvatarDrawWorkflow } from '#lib/avatar-draw-workflow.svelte.js';
import type { ModelCatalogue } from '#lib/model-catalogue.svelte.js';
import type { ChatMessage, MessageImage, ModelEntry } from '#lib/types/api.js';

const model = (id: string, kind: ModelEntry['kind'] = 'image') =>
	({ id, kind, displayName: id.toUpperCase() }) as ModelEntry;

const msg = (
	id: string,
	role: ChatMessage['role'],
	parentMessageId: string | null,
	parts: ChatMessage['parts'],
) => ({ id, role, parentMessageId, parts }) as ChatMessage;

const text = (t: string): ChatMessage['parts'] => [{ type: 'text', text: t }];

/** A portrait version on a reply. */
const portrait = (id: string, over: Partial<MessageImage> = {}): MessageImage => ({
	id,
	kind: 'portrait',
	markerIndex: null,
	mediaId: `media-${id}`,
	error: null,
	inComparison: false,
	modelId: 'img-1',
	shown: false,
	aspectRatio: null,
	width: null,
	height: null,
	createdAt: 0,
	...over,
});

function setup(
	opts: {
		saved?: string | null;
		status?: string;
		messages?: ChatMessage[];
		face?: string | null;
	} = {},
) {
	const page = {
		convId: 'A',
		messages: opts.messages ?? [
			msg('u1', 'user', null, text('Describe yourself')),
			msg('a1', 'assistant', 'u1', text('<description>a red fox</description>')),
		],
	};
	const catalogue = {
		all: [model('chat-m', 'chat'), model('img-1'), model('img-2')],
		status: opts.status ?? 'full',
		ensureAll: vi.fn(async () => {}),
	} as unknown as ModelCatalogue;
	const refreshPhotos = vi.fn(async (_ids: string[]) => {});
	const w = new AvatarDrawWorkflow({
		convId: () => page.convId,
		messages: () => page.messages,
		catalogue,
		savedModelId: () => opts.saved,
		enhanceByDefault: () => false,
		avatarMediaId: () => opts.face ?? null,
		refreshPhotos,
	});
	return { w, page, catalogue, refreshPhotos };
}

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
	toasts.error.mockReset();
	fetchMock = vi.fn(async () => new Response('{}'));
	vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe('the draw model', () => {
	it('uses the saved model when the catalogue has it', () => {
		expect(setup({ saved: 'img-2' }).w.modelId).toBe('img-2');
	});

	it('waits rather than substituting while a saved model may still arrive', () => {
		expect(setup({ saved: 'img-9', status: 'loading' }).w.modelId).toBe('');
	});

	it('falls back to the first image model once the catalogue is loaded', () => {
		expect(setup({ saved: 'img-9' }).w.modelId).toBe('img-1');
		expect(setup().w.imageModels.map((m) => m.id)).toEqual(['img-1', 'img-2']);
	});

	it('takes a picked model and saves it as the default', () => {
		const { w } = setup({ saved: 'img-1' });
		w.setModel('img-2');
		expect(w.modelId).toBe('img-2');
		expect(fetchMock).toHaveBeenCalledWith('/api/user/preferences', expect.anything());
	});
});

describe('the source reply', () => {
	it('is the latest assistant reply with text, and not yet drawn', () => {
		const { w } = setup();
		expect(w.sourceMessage?.id).toBe('a1');
		expect(w.alreadyDrawn).toBe(false);
	});

	it('counts a portrait on it as drawn', () => {
		const [u1, a1] = setup().page.messages;
		const { w } = setup({ messages: [u1, { ...a1, images: [portrait('p1', { shown: true })] }] });
		expect(w.alreadyDrawn).toBe(true);
	});
});

describe('the dialog', () => {
	it('opens seeded from the source reply with an empty cart', () => {
		const { w, catalogue } = setup();
		w.compareMode = true;
		w.compareSelections = [{ modelId: 'img-1', count: 2 }];
		w.openDialog();
		expect(w.open).toBe(true);
		expect(w.photo).toEqual({ replyId: 'a1', index: null });
		expect(w.prompt).toBe('a red fox');
		expect(w.enhance).toBe(false);
		expect(w.compareMode).toBe(false);
		expect(w.compareSelections).toEqual([]);
		expect(catalogue.ensureAll).toHaveBeenCalled();
	});

	it('does not open without a source reply', () => {
		const { w } = setup({ messages: [msg('u1', 'user', null, text('hi'))] });
		w.openDialog();
		expect(w.open).toBe(false);
	});

	it('reset closes it and drops the staged prompt', () => {
		const { w } = setup();
		w.openDialog();
		w.reset();
		expect(w.open).toBe(false);
		expect(w.prompt).toBe('');
	});
});

describe('drawing the avatar', () => {
	const bodies = () =>
		fetchMock.mock.calls.map(
			([, init]) => JSON.parse((init as RequestInit).body as string) as Record<string, unknown>,
		);

	it('draws a portrait onto the source reply, and closes once accepted', async () => {
		const { w, refreshPhotos } = setup();
		w.openDialog();
		w.generate();
		expect(fetchMock).toHaveBeenCalledWith(
			'/api/conversations/A/photos',
			expect.objectContaining({ method: 'POST' }),
		);
		// No marker, and no shape: a portrait is square.
		expect(bodies()[0]).toEqual({
			messageId: 'a1',
			kind: 'portrait',
			prompt: 'a red fox',
			enhance: false,
			modelId: 'img-1',
		});
		await vi.waitFor(() => expect(w.open).toBe(false));
		await vi.waitFor(() => expect(refreshPhotos).toHaveBeenCalledWith(['a1']));
	});

	it('says a portrait is drawing until its draw is done', async () => {
		let answer!: () => void;
		fetchMock.mockImplementationOnce(
			() =>
				new Promise<Response>(
					(r) => (answer = () => r(new Response(new ReadableStream({ start: (c) => c.close() })))),
				),
		);
		const { w } = setup();
		w.openDialog();
		w.generate();
		expect(w.portraitStatus).toBe('Drawing…');
		answer();
		await vi.waitFor(() => expect(w.portraitStatus).toBeNull());
	});

	it('says so for a draw the server reports, too', () => {
		const [u1, a1] = setup().page.messages;
		const { w } = setup({
			messages: [
				u1,
				{ ...a1, developing: [{ kind: 'portrait', markerIndex: null, modelId: 'img-1' }] },
			],
		});
		expect(w.portraitStatus).toBe('Drawing…');
	});

	it('compares in the dialog, any time: a draw per model, sharing an id', async () => {
		const { w } = setup();
		w.openDialog();
		w.compareMode = true;
		w.compareSelections = [
			{ modelId: 'img-1', count: 1 },
			{ modelId: 'img-2', count: 1 },
		];
		w.generate();
		expect(w.open).toBe(true);
		expect(w.photoComparison).toMatchObject({ replyId: 'a1', index: null });
		await vi.waitFor(() => expect(w.photoComparison?.pending).toEqual([]));
		const [a, b] = bodies();
		expect([a.modelId, b.modelId]).toEqual(['img-1', 'img-2']);
		expect(a.kind).toBe('portrait');
		expect(a.compare).toBeTypeOf('string');
		expect(b.compare).toBe(a.compare);
	});

	it('keeps the dialog up and says why when a draw is refused', async () => {
		fetchMock.mockResolvedValueOnce(
			new Response(JSON.stringify({ message: 'model gone' }), { status: 400 }),
		);
		const { w } = setup();
		w.openDialog();
		w.generate();
		await vi.waitFor(() => expect(toasts.error).toHaveBeenCalledWith('model gone'));
		expect(w.open).toBe(true);
	});
});

describe('removing a portrait', () => {
	const thread = (images: MessageImage[]) => [
		msg('u1', 'user', null, text('Describe yourself')),
		{ ...msg('a1', 'assistant', 'u1', text('a red fox')), images },
	];
	const urls = () =>
		fetchMock.mock.calls.map(
			([url, init]) => [url as string, (init as RequestInit | undefined)?.method] as const,
		);

	it('moves the face to the version now on show when it was the face', async () => {
		const page = { images: [portrait('p1', { shown: true }), portrait('p2')] };
		const {
			w,
			page: p,
			refreshPhotos,
		} = setup({
			messages: thread(page.images),
			face: 'media-p1',
		});
		// The page's refresh: p1 has gone to the trash, p2 shows in its place.
		refreshPhotos.mockImplementation(async () => {
			p.messages = thread([portrait('p2', { shown: true })]);
		});
		await w.removePhoto('a1', page.images[0]);
		expect(urls()).toEqual([
			['/api/media/media-p1', 'DELETE'],
			['/api/conversations/A/photos/p2', 'PATCH'],
		]);
	});

	it('goes back to the preset’s face when none is left', async () => {
		const only = portrait('p1', { shown: true });
		const { w, page, refreshPhotos } = setup({ messages: thread([only]), face: 'media-p1' });
		refreshPhotos.mockImplementation(async () => {
			page.messages = thread([]);
		});
		await w.removePhoto('a1', only);
		expect(urls()).toEqual([
			['/api/media/media-p1', 'DELETE'],
			['/api/conversations/A/avatar', 'DELETE'],
		]);
	});

	it('leaves the face alone when the version removed wasn’t it', async () => {
		const images = [portrait('p1', { shown: true }), portrait('p2')];
		const { w } = setup({ messages: thread(images), face: 'media-elsewhere' });
		await w.removePhoto('a1', images[0]);
		expect(urls()).toEqual([['/api/media/media-p1', 'DELETE']]);
	});
});

describe('drawing across a conversation switch', () => {
	it('leaves a dialog opened in another chat open when the draw is accepted', async () => {
		const { w, page } = setup();
		w.openDialog();
		fetchMock.mockImplementationOnce(async () => {
			// The user moved to B and opened B's dialog while A's POST was in flight.
			page.convId = 'B';
			w.reset();
			w.openDialog();
			return new Response(new ReadableStream({ start: (c) => c.close() }));
		});
		w.generate();
		await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
		expect(w.open).toBe(true);
	});
});

describe('developing a texting photo', () => {
	// A texting reply with two photo markers, the first developed once already.
	const reply = {
		...msg('r1', 'assistant', 'u1', text('[photo: me, 3:4]\n\n[photo: the view]')),
		images: [
			{
				id: 'v0',
				kind: 'photo',
				markerIndex: 1,
				mediaId: 'img',
				error: null,
				inComparison: false,
				modelId: 'img-1',
				shown: true,
				aspectRatio: null,
				width: null,
				height: null,
				createdAt: 0,
			},
		],
	} as ChatMessage;
	// The conversation has moved on since; photos don't care.
	const thread = [
		msg('u1', 'user', null, text('send pics')),
		reply,
		msg('u2', 'user', 'r1', text('cute')),
	];
	const bodies = () =>
		fetchMock.mock.calls.map(
			([, init]) => JSON.parse((init as RequestInit).body as string) as Record<string, unknown>,
		);

	it('develops on the reply, with the marker and the shape, and closes once accepted', async () => {
		const { w, refreshPhotos } = setup({ messages: thread });
		w.openPhotoDialog({ replyId: 'r1', index: 1 }, 'the view');
		expect(w.prompt).toBe('the view');
		w.aspectRatio = '16:9';
		w.generate();
		await vi.waitFor(() => expect(w.open).toBe(false));
		expect(fetchMock.mock.calls[0][0]).toBe('/api/conversations/A/photos');
		expect(bodies()[0]).toEqual({
			messageId: 'r1',
			index: 1,
			modelId: 'img-1',
			prompt: 'the view',
			enhance: false,
			aspectRatio: '16:9',
		});
		// A photo isn't the avatar: the header says nothing of it.
		expect(w.portraitStatus).toBeNull();
		await vi.waitFor(() => expect(refreshPhotos).toHaveBeenCalledWith(['r1']));
	});

	it('says the photo is developing until its draw is done', async () => {
		let finish!: () => void;
		fetchMock.mockImplementationOnce(
			() => new Promise<Response>((r) => (finish = () => r(new Response('{}')))),
		);
		const { w } = setup({ messages: thread });
		w.openPhotoDialog({ replyId: 'r1', index: 0 }, 'me, 3:4');
		w.generate();
		expect(w.isDeveloping('r1', 0)).toBe(true);
		expect(w.isDeveloping('r1', 1)).toBe(false);
		finish();
		await vi.waitFor(() => expect(w.isDeveloping('r1', 0)).toBe(false));
	});

	it('starts one draw however often Develop is pressed before the server answers', async () => {
		let answer!: () => void;
		fetchMock.mockImplementationOnce(
			() => new Promise<Response>((r) => (answer = () => r(new Response('{}')))),
		);
		const { w } = setup({ messages: thread });
		w.openPhotoDialog({ replyId: 'r1', index: 0 }, 'me, 3:4');
		w.generate();
		expect(w.photoSubmitting).toBe(true);
		expect(w.developingFor('r1')).toEqual(new Set([0]));
		w.generate();
		expect(fetchMock).toHaveBeenCalledTimes(1);
		answer();
		await vi.waitFor(() => expect(w.photoSubmitting).toBe(false));
	});

	it('compares in the dialog: a draw per model, sharing an id, results kept apart', async () => {
		const { w } = setup({ messages: thread });
		w.openPhotoDialog({ replyId: 'r1', index: 1 }, 'the view');
		// Always on offer — the thread having moved on doesn't matter.
		w.compareMode = true;
		w.compareSelections = [
			{ modelId: 'img-1', count: 1 },
			{ modelId: 'img-2', count: 1 },
		];
		w.generate();
		expect(w.open).toBe(true);
		expect(w.photoComparison).toMatchObject({ replyId: 'r1', index: 1, conversationId: 'A' });
		// What the photo had before, so the dialog shows only what this adds.
		expect([...w.photoComparison!.before]).toEqual(['v0']);
		await vi.waitFor(() => expect(w.photoComparison?.pending).toEqual([]));
		const [a, b] = bodies();
		expect([a.modelId, b.modelId]).toEqual(['img-1', 'img-2']);
		expect(a.compare).toBeTypeOf('string');
		expect(b.compare).toBe(a.compare);
	});

	it('picks a comparison’s result, counting it, and closes the dialog', async () => {
		const { w } = setup({ messages: thread });
		w.openPhotoDialog({ replyId: 'r1', index: 1 }, 'the view');
		await w.showPhoto('r1', reply.images![0], true);
		expect(fetchMock).toHaveBeenCalledWith(
			'/api/conversations/A/photos/v0',
			expect.objectContaining({ method: 'PATCH' }),
		);
		expect(bodies()[0]).toEqual({ shown: true, pick: true });
		expect(w.open).toBe(false);
	});

	it('leaves a dialog opened in another chat alone when a pick lands', async () => {
		let answer!: () => void;
		fetchMock.mockImplementationOnce(
			() => new Promise<Response>((r) => (answer = () => r(new Response('{}')))),
		);
		const { w, page } = setup({ messages: thread });
		w.openPhotoDialog({ replyId: 'r1', index: 1 }, 'the view');
		const picking = w.showPhoto('r1', reply.images![0], true);
		page.convId = 'B';
		w.openDialog();
		answer();
		await picking;
		expect(w.open).toBe(true);
	});

	it('switches versions at once, and back if the server refuses', async () => {
		const { w } = setup({ messages: thread });
		const other = { ...reply.images![0], id: 'v1' };
		await w.showPhoto('r1', other);
		expect(w.shownVersion('r1', 1)).toBe('v1');
		expect(bodies()[0]).toEqual({ shown: true });

		fetchMock.mockResolvedValueOnce(new Response('{"message":"nope"}', { status: 404 }));
		await w.showPhoto('r1', reply.images![0]);
		expect(w.shownVersion('r1', 1)).toBe('v1');
	});

	it('removes a version by moving its image to the trash', async () => {
		const { w, refreshPhotos } = setup({ messages: thread });
		await w.removePhoto('r1', reply.images![0]);
		expect(fetchMock).toHaveBeenCalledWith('/api/media/img', { method: 'DELETE' });
		// Just that reply, wherever it is on the page — no reload of the window.
		expect(refreshPhotos).toHaveBeenCalledWith(['r1']);
	});

	it('goes back to drawing the avatar when the avatar dialog is opened', () => {
		const { w } = setup();
		w.openPhotoDialog({ replyId: 'a1', index: 0 }, 'x');
		w.openDialog();
		expect(w.photo).toEqual({ replyId: 'a1', index: null });
		expect(w.prompt).toBe('a red fox');
	});
});
