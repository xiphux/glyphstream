/**
 * A photo comparison as a fan-out grid (`PhotoComparisonGrid`): which columns
 * it shows, and that each triage action is the version's own. Runs the real
 * workflow (its runes compile under the sveltekit() plugin) with fetch stubbed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('$app/navigation', () => ({ refreshAll: async () => {} }));
vi.mock('#lib/toast.svelte.js', () => ({ toast: { success: () => {}, error: () => {} } }));

import { AvatarDrawWorkflow } from '#lib/avatar-draw-workflow.svelte.js';
import { PhotoComparisonGrid } from '#lib/photo-comparison-grid.svelte.js';
import type { AvatarDrawController } from '#lib/avatar-draw-controller.svelte.js';
import type { FanoutController } from '#lib/fanout-controller.svelte.js';
import type { ModelCatalogue } from '#lib/model-catalogue.svelte.js';
import type { ChatMessage, MessageImage, ModelEntry } from '#lib/types/api.js';

const version = (id: string, over: Partial<MessageImage> = {}): MessageImage => ({
	id,
	kind: 'photo',
	markerIndex: 0,
	mediaId: `media-${id}`,
	error: null,
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
		draw: {} as AvatarDrawController,
		fanout: {} as FanoutController,
		refreshPhotos: async () => {},
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
		await workflow.generate();
		page.messages = [{ ...reply, images: [...reply.images!, ...landed] }];
	}
	return { workflow, grid, compare, page };
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
