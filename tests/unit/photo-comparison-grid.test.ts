/**
 * A photo comparison as a fan-out grid (`PhotoComparisonGrid`): which columns
 * it shows, and that each triage action is the version's own. Runs the real
 * workflow (its runes compile under the sveltekit() plugin) with fetch stubbed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('$app/navigation', () => ({ refreshAll: async () => {} }));
vi.mock('#lib/toast.svelte.js', () => ({ toast: { success: () => {}, error: () => {} } }));

import { AvatarDrawWorkflow } from '#lib/avatar-draw-workflow.svelte.js';
import { PhotoComparisonGrid, PhotoVersionTriage } from '#lib/photo-comparison-grid.svelte.js';
import type { ModelCatalogue } from '#lib/model-catalogue.svelte.js';
import type { ChatMessage, MessageImage, ModelEntry } from '#lib/types/api.js';

const version = (id: string, over: Partial<MessageImage> = {}): MessageImage => ({
	id,
	kind: 'photo',
	markerIndex: 0,
	mediaId: `media-${id}`,
	error: null,
	inComparison: false,
	modelId: 'img-1',
	shown: false,
	aspectRatio: '3:4',
	width: null,
	height: null,
	createdAt: 0,
	...over,
});

function setup() {
	const reply = {
		id: 'r1',
		role: 'assistant',
		parentMessageId: 'u1',
		parts: [{ type: 'text', text: '[photo: the view]' }],
		images: [version('old')],
	} as ChatMessage;
	const page = { messages: [reply] };
	const workflow = new AvatarDrawWorkflow({
		convId: () => 'A',
		messages: () => page.messages,
		catalogue: {
			all: [
				{ id: 'img-1', kind: 'image', displayName: 'One' },
				{ id: 'img-2', kind: 'image', displayName: 'Two' },
			] as ModelEntry[],
			status: 'full',
			ensureAll: async () => {},
		} as unknown as ModelCatalogue,
		savedModelId: () => 'img-1',
		enhanceByDefault: () => false,
		avatarMediaId: () => null,
		refreshPhotos: async () => true,
		assumeDeveloping: () => {},
	});
	const grid = new PhotoComparisonGrid({
		workflow,
		messages: () => page.messages,
		modelLabel: (id) => (id === 'img-1' ? 'One' : 'Two'),
	});
	/** Start a two-model comparison, and land `landed` as its results. */
	async function compare(landed: MessageImage[]) {
		workflow.openPhotoDialog({ replyId: 'r1', index: 0 }, 'the view');
		workflow.compareMode = true;
		workflow.compareSelections = [
			{ modelId: 'img-1', count: 1 },
			{ modelId: 'img-2', count: 1 },
		];
		workflow.generate();
		page.messages = [{ ...reply, images: [...reply.images!, ...landed] }];
	}
	const versions = new PhotoVersionTriage({
		workflow,
		messages: () => page.messages,
		modelLabel: (id) => (id === 'img-1' ? 'One' : 'Two'),
	});
	return { workflow, grid, compare, page, versions };
}

let fetchMock: ReturnType<typeof vi.fn>;
let release: () => void;
beforeEach(() => {
	// Draws stay out until released, so the placeholders can be seen.
	const held = new Promise<void>((r) => (release = r));
	fetchMock = vi.fn(async (url: string) => {
		if (url.endsWith('/photos')) await held;
		return new Response('{}');
	});
	vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
	release();
	vi.unstubAllGlobals();
});

const posts = () =>
	fetchMock.mock.calls
		.filter(([url]) => (url as string).endsWith('/photos'))
		.map(([, init]) => JSON.parse((init as RequestInit).body as string) as Record<string, unknown>);

describe('PhotoComparisonGrid', () => {
	it('shows nothing until a comparison starts', () => {
		const { grid } = setup();
		expect(grid.active).toBe(false);
		expect(grid.columns).toEqual([]);
	});

	it('shows what the comparison drew, and a placeholder per draw still out', async () => {
		const { grid, compare } = setup();
		await compare([version('a', { modelId: 'img-2' })]);
		expect(grid.active).toBe(true);
		const cols = grid.columns;
		// The photo's earlier version isn't part of this comparison.
		expect(cols.map((c) => [c.label, c.status])).toEqual([
			['Two', 'done'],
			['One', 'streaming'],
			['Two', 'streaming'],
		]);
		expect(cols[0].persisted?.parts).toEqual([
			{ type: 'image', mediaId: 'media-a', aspectRatio: '3:4' },
		]);
		expect(cols[1].statusLabel).toBe('Developing…');
	});

	it('keeps a placeholder for each draw the server still has, once this tab’s are gone', async () => {
		const { grid, compare, workflow, page } = setup();
		await compare([]);
		const id = workflow.photoComparison!.id;
		const out = (modelId: string, compareId: string | null = id) => ({
			kind: 'photo' as const,
			markerIndex: 0,
			modelId,
			compareId,
		});
		// The server's word on draws this tab is still waiting on doesn't add
		// to them; another draw of the photo isn't this comparison's.
		page.messages = [
			{ ...page.messages[0], developing: [out('img-1'), out('img-2'), out('img-1', null)] },
		];
		expect(grid.columns.map((c) => [c.label, c.status])).toEqual([
			['One', 'streaming'],
			['Two', 'streaming'],
		]);
		// The requests go — as a suspended PWA's do — with Two's draw landed and
		// One's still out on the server.
		release();
		await vi.waitFor(() => expect(workflow.photoComparison?.pending).toEqual([]));
		page.messages = [
			{
				...page.messages[0],
				images: [...page.messages[0].images!, version('b', { modelId: 'img-2' })],
				developing: [out('img-1')],
			},
		];
		expect(grid.columns.map((c) => [c.label, c.status])).toEqual([
			['Two', 'done'],
			['One', 'streaming'],
		]);
	});

	it('shows a failed draw as a failed column', async () => {
		const { grid, compare } = setup();
		await compare([version('f', { mediaId: null, error: 'out of memory' })]);
		expect(grid.columns[0]).toMatchObject({ status: 'error', error: 'out of memory' });
		expect(grid.canRegenerate(grid.columns[0])).toBe(true);
		expect(grid.canRegenerate(grid.columns[1])).toBe(false);
	});

	it('re-rolls a column as another draw of the same comparison', async () => {
		const { grid, compare, workflow } = setup();
		await compare([version('a', { modelId: 'img-2' })]);
		await grid.regenerate(grid.columns[0]);
		expect(workflow.photoComparison?.pending).toEqual(['img-1', 'img-2', 'img-2']);
		const [first, , again] = posts();
		expect(again).toMatchObject({ modelId: 'img-2', messageId: 'r1', index: 0 });
		expect(again.compare).toBe(first.compare);
	});

	it('picks a column as the one to show, counting the comparison', async () => {
		const { grid, compare, workflow } = setup();
		await compare([version('a')]);
		await grid.pick(grid.columns[0]);
		expect(fetchMock).toHaveBeenCalledWith(
			'/api/conversations/A/photos/a',
			expect.objectContaining({
				method: 'PATCH',
				body: JSON.stringify({ shown: true, pick: true }),
			}),
		);
		expect(workflow.open).toBe(false);
	});

	it('trashes a column’s image and drops it from the grid', async () => {
		const { grid, compare } = setup();
		await compare([version('a'), version('b')]);
		expect(await grid.discard(grid.columns[0])).toBe(true);
		expect(fetchMock).toHaveBeenCalledWith('/api/media/media-a', { method: 'DELETE' });
		expect(grid.columns.map((c) => c.branchId).slice(0, 1)).toEqual(['b']);
	});

	it('clears a failed column without deleting anything', async () => {
		const { grid, compare } = setup();
		await compare([version('f', { mediaId: null, error: 'boom' })]);
		expect(await grid.discard(grid.columns[0])).toBe(true);
		expect(
			fetchMock.mock.calls.some(([, init]) => (init as RequestInit)?.method === 'DELETE'),
		).toBe(false);
		expect(grid.columns.every((c) => c.status === 'streaming')).toBe(true);
	});
});

describe('PhotoVersionTriage', () => {
	function thread() {
		const t = setup();
		t.page.messages = [
			{
				...t.page.messages[0],
				images: [
					version('old', { shown: true }),
					version('a', { inComparison: true, modelId: 'img-2' }),
					version('f', { inComparison: true, mediaId: null, error: 'boom' }),
				],
			},
		];
		return t;
	}

	it('triages a version with an image, the grid’s way only for a comparison’s', () => {
		const { versions } = thread();
		expect(versions.columns.map((c) => [c.branchId, c.label])).toEqual([
			['old', 'One'],
			['a', 'Two'],
		]);
		const [old, a] = versions.columns;
		expect([versions.triages(old), versions.triages(a)]).toEqual([false, true]);
		expect(versions.pickLabels(old)).toBeNull();
		expect(versions.pickLabels(a)).toEqual({ label: 'Show this one', caption: 'Show' });
		expect(versions.canDiscard()).toBe(true);
	});

	it('picks a comparison’s result, counting the comparison', async () => {
		const { versions } = thread();
		await versions.pick(versions.columns[1]);
		expect(fetchMock).toHaveBeenCalledWith(
			'/api/conversations/A/photos/a',
			expect.objectContaining({ body: JSON.stringify({ shown: true, pick: true }) }),
		);
	});

	it('picks nothing that isn’t a comparison’s', async () => {
		const { versions } = thread();
		await versions.pick(versions.columns[0]);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it('deletes a version by moving its image to the trash', async () => {
		const { versions } = thread();
		expect(await versions.discard(versions.columns[0])).toBe(true);
		expect(fetchMock).toHaveBeenCalledWith('/api/media/media-old', { method: 'DELETE' });
	});

	it('says so when the trash refuses it', async () => {
		const { versions } = thread();
		fetchMock.mockResolvedValueOnce(new Response('{}', { status: 500 }));
		expect(await versions.discard(versions.columns[0])).toBe(false);
	});
});
