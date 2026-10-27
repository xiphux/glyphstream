/**
 * Unit tests for the avatar draw dialog's workflow, lifted out of the chat page.
 *
 * The workflow runs its real runes (the sveltekit() vitest plugin compiles the
 * .svelte.ts module). The catalogue, the recovery controller and the fan-out
 * controller are stubs: the first is a list, and the other two are where the
 * workflow hands work off, so the stubs record what it handed them.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('$app/navigation', () => ({ refreshAll: async () => {} }));
vi.mock('#lib/toast.svelte.js', () => ({ toast: { success: () => {}, error: () => {} } }));

import { AvatarDrawWorkflow } from '#lib/avatar-draw-workflow.svelte.js';
import type { AvatarDrawController } from '#lib/avatar-draw-controller.svelte.js';
import type { FanoutController } from '#lib/fanout-controller.svelte.js';
import type { ModelCatalogue } from '#lib/model-catalogue.svelte.js';
import type { ChatMessage, ModelEntry } from '#lib/types/api.js';

const model = (id: string, kind: ModelEntry['kind'] = 'image') =>
	({ id, kind, displayName: id.toUpperCase() }) as ModelEntry;

const msg = (
	id: string,
	role: ChatMessage['role'],
	parentMessageId: string | null,
	parts: ChatMessage['parts'],
) => ({ id, role, parentMessageId, parts }) as ChatMessage;

const text = (t: string): ChatMessage['parts'] => [{ type: 'text', text: t }];
const image = [{ type: 'image', mediaId: 'img' }] as unknown as ChatMessage['parts'];

function setup(opts: { saved?: string | null; status?: string; messages?: ChatMessage[] } = {}) {
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
	const draw = {
		status: null as string | null,
		begin: vi.fn(),
		setStatus: vi.fn(),
		completed: vi.fn(),
		wasInterrupted: vi.fn(() => false),
		reportFailure: vi.fn(),
		end: vi.fn(),
	};
	const fanout = { sendAvatarDraw: vi.fn(async () => {}) };
	const w = new AvatarDrawWorkflow({
		convId: () => page.convId,
		messages: () => page.messages,
		catalogue,
		savedModelId: () => opts.saved,
		enhanceByDefault: () => false,
		draw: draw as unknown as AvatarDrawController,
		fanout: fanout as unknown as FanoutController,
	});
	return { w, page, catalogue, draw, fanout };
}

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
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
		expect(w.canCompare).toBe(true);
	});

	it('counts a portrait under it as drawn, and still allows a comparison', () => {
		const { w } = setup({
			messages: [...setup().page.messages, msg('p1', 'assistant', 'a1', image)],
		});
		expect(w.sourceMessage?.id).toBe('a1');
		expect(w.alreadyDrawn).toBe(true);
		expect(w.canCompare).toBe(true);
	});

	it('refuses a comparison once the thread has moved past the description', () => {
		const { w } = setup({
			messages: [
				...setup().page.messages,
				msg('p1', 'assistant', 'a1', image),
				msg('u2', 'user', 'p1', text('Nice')),
			],
		});
		expect(w.sourceMessage?.id).toBe('a1');
		expect(w.canCompare).toBe(false);
	});
});

describe('the dialog', () => {
	it('opens seeded from the source reply with an empty cart', () => {
		const { w, catalogue } = setup();
		w.compareMode = true;
		w.compareSelections = [{ modelId: 'img-1', count: 2 }];
		w.openDialog();
		expect(w.open).toBe(true);
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

describe('drawing', () => {
	it('sends two or more models as a fan-out comparison, not a single draw', async () => {
		const { w, fanout } = setup();
		w.openDialog();
		w.compareMode = true;
		w.compareSelections = [
			{ modelId: 'img-1', count: 1 },
			{ modelId: 'img-2', count: 1 },
		];
		await w.generate();
		expect(fanout.sendAvatarDraw).toHaveBeenCalledWith({
			sourceMessageId: 'a1',
			prompt: 'a red fox',
			enhance: false,
			branches: [
				{ modelId: 'img-1', modelKind: 'image', displayName: 'IMG-1' },
				{ modelId: 'img-2', modelKind: 'image', displayName: 'IMG-2' },
			],
		});
		expect(w.open).toBe(false);
		expect(w.compareSelections).toEqual([]);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it('keeps the dialog up and reports the server reason when a draw is refused', async () => {
		fetchMock.mockResolvedValueOnce(
			new Response(JSON.stringify({ message: 'model gone' }), { status: 400 }),
		);
		const { w, draw } = setup();
		w.openDialog();
		await w.generate();
		expect(fetchMock).toHaveBeenCalledWith(
			'/api/conversations/A/avatar/generate',
			expect.objectContaining({ method: 'POST' }),
		);
		expect(w.open).toBe(true);
		expect(draw.reportFailure).toHaveBeenCalledWith('A', 'model gone');
		expect(draw.end).toHaveBeenCalledWith('A');
	});

	it('does not start a second draw over one already running', async () => {
		const { w, draw } = setup();
		draw.status = 'Drawing…';
		w.openDialog();
		await w.generate();
		expect(fetchMock).not.toHaveBeenCalled();
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
		await w.generate();
		expect(w.open).toBe(true);
	});
});

describe('developing a texting photo', () => {
	// A texting reply with a photo marker, then the first photo developed from it.
	const reply = msg('r1', 'assistant', 'u1', text('[photo: me, 3:4]\n\n[photo: the view]'));
	const p0 = msg('p0', 'assistant', 'r1', [
		{ type: 'image', mediaId: 'img', photo: { sourceMessageId: 'r1', index: 0 } },
	]);
	const thread = [msg('u1', 'user', null, text('send pics')), reply, p0];
	const origin = { sourceMessageId: 'r1', index: 1 };
	const sentBody = () =>
		JSON.parse((fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string) as Record<
			string,
			unknown
		>;

	it('hangs the photo under its anchor and sends the marker, the shape and no avatar', async () => {
		const { w } = setup({ messages: thread });
		w.openPhotoDialog({ origin, anchorId: 'p0' }, 'the view');
		expect(w.prompt).toBe('the view');
		w.aspectRatio = '16:9';
		await w.generate();
		const body = sentBody();
		expect(body).toEqual({
			sourceMessageId: 'p0',
			modelId: 'img-1',
			prompt: 'the view',
			enhance: false,
			photo: origin,
			aspectRatio: '16:9',
		});
	});

	it('names the photo it replaces when developing one again', async () => {
		const { w } = setup({ messages: thread });
		w.openPhotoDialog(
			{ origin: { sourceMessageId: 'r1', index: 0 }, anchorId: 'r1', replacesId: 'p0' },
			'me, 3:4',
		);
		// p0 is the leaf and a child of the anchor, so its siblings can be compared.
		expect(w.canCompare).toBe(true);
		await w.generate();
		const body = sentBody();
		expect(body).toMatchObject({ sourceMessageId: 'r1', expectLeafMessageId: 'p0' });
	});

	it('compares photos with the marker and shape on every branch', async () => {
		const { w, fanout } = setup({ messages: thread });
		w.openPhotoDialog({ origin, anchorId: 'p0' }, 'the view');
		w.aspectRatio = '4:3';
		w.compareMode = true;
		w.compareSelections = [
			{ modelId: 'img-1', count: 1 },
			{ modelId: 'img-2', count: 1 },
		];
		await w.generate();
		expect(fanout.sendAvatarDraw).toHaveBeenCalledWith(
			expect.objectContaining({ sourceMessageId: 'p0', photo: origin, aspectRatio: '4:3' }),
		);
	});

	it('goes back to drawing the avatar when the avatar dialog is opened', () => {
		const { w } = setup();
		w.openPhotoDialog({ origin, anchorId: 'a1' }, 'x');
		w.openDialog();
		expect(w.photo).toBe(null);
		expect(w.prompt).toBe('a red fox');
	});
});
