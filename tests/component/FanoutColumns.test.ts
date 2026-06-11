/* @vitest-environment happy-dom */

/**
 * Component test for FanoutColumns — the multi-model compare view. Verifies
 * the column-per-model render, the streaming-vs-settled status, and that
 * "Continue with this" is gated to settled columns and reports the picked
 * column. Discard is optional (text fan-out omits it); covered here too.
 */

import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import FanoutColumns from '$lib/components/chat/FanoutColumns.svelte';
import { MAX_FANOUT_BRANCHES_PER_CONVERSATION, type FanoutColumn } from '$lib/fanout';
import type { ChatMessage } from '$lib/types/api';

function persisted(id: string, text: string): ChatMessage {
	return {
		id,
		role: 'assistant',
		parts: [{ type: 'text', text }],
		contentHtml: `<p>${text}</p>`,
		reasoningText: null,
		modelUsed: 'bridge::a',
	} as unknown as ChatMessage;
}

function col(overrides: Partial<FanoutColumn>): FanoutColumn {
	return {
		branchId: overrides.branchId ?? 'b0',
		modelId: overrides.modelId ?? 'bridge::a',
		modelKind: 'chat',
		label: overrides.label ?? 'Model A',
		segments: overrides.segments ?? [],
		status: overrides.status ?? 'streaming',
		queuedAhead: overrides.queuedAhead ?? 0,
		progress: overrides.progress ?? null,
		startedAt: overrides.startedAt ?? null,
		inputMediaId: overrides.inputMediaId ?? null,
		persisted: overrides.persisted ?? null,
		error: overrides.error ?? null,
	};
}

describe('FanoutColumns', () => {
	it('renders one column per model with a count header', () => {
		render(FanoutColumns, {
			props: {
				columns: [
					col({ branchId: 'b0', label: 'Model A' }),
					col({ branchId: 'b1', label: 'Model B' }),
				],
				onPick: vi.fn(),
				onImageClick: vi.fn(),
			},
		});
		expect(screen.getByText(/Comparing 2 models/i)).toBeTruthy();
		expect(screen.getByText('Model A')).toBeTruthy();
		expect(screen.getByText('Model B')).toBeTruthy();
	});

	it('gates "Continue with this" to settled columns and reports the pick', async () => {
		const onPick = vi.fn();
		render(FanoutColumns, {
			props: {
				columns: [
					col({
						branchId: 'b0',
						label: 'Model A',
						status: 'done',
						persisted: persisted('a1', 'Answer A'),
					}),
					col({ branchId: 'b1', label: 'Model B', status: 'streaming' }),
				],
				onPick,
				onImageClick: vi.fn(),
			},
		});
		const buttons = screen.getAllByRole('button', { name: /continue with this/i });
		expect(buttons).toHaveLength(2);
		// Column A (done) is enabled; column B (still streaming) is disabled.
		expect((buttons[0] as HTMLButtonElement).disabled).toBe(false);
		expect((buttons[1] as HTMLButtonElement).disabled).toBe(true);

		await userEvent.click(buttons[0]);
		expect(onPick).toHaveBeenCalledTimes(1);
		expect(onPick.mock.calls[0][0].branchId).toBe('b0');
	});

	it('shows the rendered response text for a settled column', () => {
		render(FanoutColumns, {
			props: {
				columns: [col({ status: 'done', persisted: persisted('a1', 'Answer A') })],
				onPick: vi.fn(),
				onImageClick: vi.fn(),
			},
		});
		expect(screen.getByText('Answer A')).toBeTruthy();
	});

	it('renders a discard control only when onDiscard is provided', async () => {
		const onDiscard = vi.fn();
		const { rerender } = render(FanoutColumns, {
			props: {
				columns: [col({ status: 'done', persisted: persisted('a1', 'A') })],
				onPick: vi.fn(),
				onImageClick: vi.fn(),
			},
		});
		expect(screen.queryByRole('button', { name: /discard this response/i })).toBeNull();

		await rerender({
			columns: [col({ status: 'done', persisted: persisted('a1', 'A') })],
			onPick: vi.fn(),
			onDiscard,
			onImageClick: vi.fn(),
		});
		expect(screen.getByRole('button', { name: /discard this response/i })).toBeTruthy();
	});
});

describe('FanoutColumns — media (keep-many) mode', () => {
	function mediaCol(branchId: string, status: FanoutColumn['status'] = 'done'): FanoutColumn {
		return {
			...col({ branchId, status, label: 'SDXL', persisted: persisted(branchId, 'img') }),
			modelKind: 'image',
		};
	}

	it('shows Regenerate + Discard and no "Continue with this" when onPick is omitted', () => {
		render(FanoutColumns, {
			props: {
				columns: [mediaCol('b0'), mediaCol('b1')],
				onDiscard: vi.fn(),
				onRegenerate: vi.fn(),
				onImageClick: vi.fn(),
			},
		});
		expect(screen.queryByRole('button', { name: /continue with this/i })).toBeNull();
		expect(screen.getAllByRole('button', { name: /regenerate/i })).toHaveLength(2);
		expect(screen.getAllByRole('button', { name: /discard this response/i })).toHaveLength(2);
		expect(screen.getByText(/2 variations/i)).toBeTruthy();
	});

	it('reports the picked column to onRegenerate', async () => {
		const onRegenerate = vi.fn();
		render(FanoutColumns, {
			props: {
				columns: [mediaCol('b0'), mediaCol('b1')],
				onDiscard: vi.fn(),
				onRegenerate,
				onImageClick: vi.fn(),
			},
		});
		await userEvent.click(screen.getAllByRole('button', { name: /regenerate/i })[1]);
		expect(onRegenerate).toHaveBeenCalledTimes(1);
		expect(onRegenerate.mock.calls[0][0].branchId).toBe('b1');
	});

	it('disables Regenerate everywhere once the active-branch cap is reached', () => {
		// A settled column (normally re-rollable) alongside enough in-flight columns
		// to hit the active ceiling — since re-roll is additive, the cap must block
		// even the settled column's Regenerate until something finishes.
		const active = Array.from({ length: MAX_FANOUT_BRANCHES_PER_CONVERSATION }, (_, i) =>
			mediaCol(`gen-${i}`, 'streaming'),
		);
		render(FanoutColumns, {
			props: {
				columns: [mediaCol('settled', 'done'), ...active],
				onDiscard: vi.fn(),
				onRegenerate: vi.fn(),
				onImageClick: vi.fn(),
			},
		});
		const regen = screen.getAllByRole('button', { name: /regenerate/i });
		expect(regen.every((b) => (b as HTMLButtonElement).disabled)).toBe(true);
	});

	it('disables discard on the last kept image (keep at least one)', () => {
		render(FanoutColumns, {
			props: {
				columns: [mediaCol('only')],
				onDiscard: vi.fn(),
				onRegenerate: vi.fn(),
				onImageClick: vi.fn(),
			},
		});
		const discard = screen.getByRole('button', { name: /discard this response/i });
		expect((discard as HTMLButtonElement).disabled).toBe(true);
	});

	it('shows the split input-image thumbnail in the column header', () => {
		const { container } = render(FanoutColumns, {
			props: {
				columns: [
					{ ...col({ branchId: 'v0', label: 'SDXL' }), modelKind: 'image', inputMediaId: 'src-7' },
				],
				onDiscard: vi.fn(),
				onRegenerate: vi.fn(),
				onImageClick: vi.fn(),
			},
		});
		const thumb = container.querySelector<HTMLImageElement>('header img');
		expect(thumb?.getAttribute('src')).toBe('/api/media/src-7/content');
	});

	it('shows a QUEUED badge (with how many are ahead) for a waiting branch', () => {
		render(FanoutColumns, {
			props: {
				columns: [col({ branchId: 'q', status: 'queued', queuedAhead: 2 })],
				onPick: vi.fn(),
				onImageClick: vi.fn(),
			},
		});
		expect(screen.getByText('Queued')).toBeInTheDocument();
		expect(screen.getByText('2 ahead')).toBeInTheDocument();
	});

	it('shows an elapsed timer in the body of the actively-generating branch', () => {
		render(FanoutColumns, {
			props: {
				// Started ~4.2s ago, no image yet → "Generating… 4.2s".
				columns: [col({ branchId: 'g', status: 'streaming', startedAt: Date.now() - 4200 })],
				onPick: vi.fn(),
				onImageClick: vi.fn(),
			},
		});
		expect(screen.getByText('Generating…')).toBeInTheDocument();
		expect(screen.getByText(/\d+\.\ds/)).toBeInTheDocument(); // e.g. "4.2s"
	});

	it('shows the video poll progress in the column header', () => {
		render(FanoutColumns, {
			props: {
				columns: [
					{
						...col({ branchId: 'v0', label: 'Sora', status: 'streaming' }),
						modelKind: 'video',
						progress: 47,
					},
				],
				onDiscard: vi.fn(),
				onRegenerate: vi.fn(),
				onImageClick: vi.fn(),
			},
		});
		expect(screen.getByText('47%')).toBeTruthy();
	});

	it('lays images out as a vertical grid, text as a horizontal strip', () => {
		const { container: mediaC } = render(FanoutColumns, {
			props: {
				columns: [mediaCol('b0'), mediaCol('b1')],
				onDiscard: vi.fn(),
				onRegenerate: vi.fn(),
				onImageClick: vi.fn(),
			},
		});
		// Image fan-out wraps into a grid the user scrolls vertically…
		expect(mediaC.querySelector('.grid')).not.toBeNull();
		expect(mediaC.querySelector('.overflow-x-auto')).toBeNull();

		const { container: textC } = render(FanoutColumns, {
			props: {
				columns: [col({ branchId: 't0', status: 'done', persisted: persisted('t0', 'A') })],
				onPick: vi.fn(),
				onImageClick: vi.fn(),
			},
		});
		// …text stays a horizontal compare strip.
		expect(textC.querySelector('.overflow-x-auto')).not.toBeNull();
		expect(textC.querySelector('.grid')).toBeNull();
	});
});
