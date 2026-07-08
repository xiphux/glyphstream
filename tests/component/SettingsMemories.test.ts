/* @vitest-environment happy-dom */

/**
 * Component test for the memories settings page. The page renders a
 * list of saved memories with a hover-revealed trash button that opens
 * the app-wide ConfirmDialog; confirming fires a DELETE and then
 * invalidates the load. The delete-confirm flow itself is exhaustively
 * covered by ConfirmDialog.test.ts — here we just prove the page
 * wires up the right call and renders correctly in the empty and
 * non-empty states.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { tick } from 'svelte';
import { render, screen, within } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import type { Memory, DeletedMemory } from '$lib/types/api';

const invalidateMock = vi.fn();
vi.mock('$app/navigation', () => ({
	invalidate: (key: string) => invalidateMock(key),
	goto: vi.fn(),
}));

// The page renders the trash button but the confirm modal itself is
// the global <ConfirmDialog> host that lives once in the (app) layout —
// not the page's own subtree. Render that host alongside the page in
// the test so the confirm UI actually appears.
import MemoriesPage from '../../src/routes/(app)/settings/memories/+page.svelte';
import ConfirmDialog from '$lib/components/ConfirmDialog.svelte';
import { confirmDialog } from '$lib/confirm.svelte';

const fetchMock = vi.fn();

beforeEach(() => {
	invalidateMock.mockReset();
	fetchMock.mockReset();
	globalThis.fetch = fetchMock as unknown as typeof fetch;
});

afterEach(() => {
	if (confirmDialog.pending) confirmDialog.cancel();
});

function mkMemory(over: Partial<Memory> = {}): Memory {
	return {
		id: over.id ?? 'm1',
		content: over.content ?? 'prefers metric units',
		createdAt: over.createdAt ?? Date.now(),
		updatedAt: over.updatedAt ?? Date.now(),
	};
}

function mkDeleted(over: Partial<DeletedMemory> = {}): DeletedMemory {
	return {
		id: over.id ?? 'd1',
		content: over.content ?? 'works at Acme',
		deletedAt: over.deletedAt ?? Date.now(),
		supersededByContent: 'supersededByContent' in over ? (over.supersededByContent ?? null) : null,
	};
}

describe('Memories settings page — empty state', () => {
	it('shows the empty-state message when no memories are saved', () => {
		render(MemoriesPage, { props: { data: { memories: [] } } });
		expect(screen.getByText(/No memories saved yet/)).toBeInTheDocument();
	});

	it('does not render any forget buttons when the list is empty', () => {
		render(MemoriesPage, { props: { data: { memories: [] } } });
		expect(screen.queryByLabelText('Forget memory')).toBeNull();
	});
});

describe('Memories settings page — list rendering', () => {
	it('renders each memory’s content', () => {
		render(MemoriesPage, {
			props: {
				data: {
					memories: [
						mkMemory({ id: 'a', content: 'prefers metric units' }),
						mkMemory({ id: 'b', content: 'works at Acme' }),
					],
				},
			},
		});
		expect(screen.getByText('prefers metric units')).toBeInTheDocument();
		expect(screen.getByText('works at Acme')).toBeInTheDocument();
	});

	it('renders one forget button per memory', () => {
		render(MemoriesPage, {
			props: {
				data: {
					memories: [mkMemory({ id: 'a' }), mkMemory({ id: 'b' })],
				},
			},
		});
		expect(screen.getAllByLabelText('Forget memory')).toHaveLength(2);
	});
});

describe('Memories settings page — delete flow', () => {
	it('opens the ConfirmDialog with the memory content as the message', async () => {
		const user = userEvent.setup();
		render(MemoriesPage, {
			props: { data: { memories: [mkMemory({ id: 'm1', content: 'prefers metric units' })] } },
		});
		render(ConfirmDialog);

		await user.click(screen.getByLabelText('Forget memory'));
		await tick();

		const dialog = screen.getByRole('alertdialog');
		expect(dialog).toBeInTheDocument();
		// The list and the dialog both contain "prefers metric units" — scope
		// the assertion to the dialog so we don't accidentally pass on the
		// list rendering alone.
		expect(within(dialog).getByText('Forget this memory?')).toBeInTheDocument();
		expect(within(dialog).getByText('prefers metric units')).toBeInTheDocument();
		// The confirm button is labelled "Forget", not the default "Delete".
		expect(within(dialog).getByRole('button', { name: 'Forget' })).toBeInTheDocument();
	});

	it('issues a DELETE and invalidates the memories key when the user confirms', async () => {
		const user = userEvent.setup();
		fetchMock.mockResolvedValue(new Response(null, { status: 204 }));
		render(MemoriesPage, {
			props: { data: { memories: [mkMemory({ id: 'm1', content: 'fact' })] } },
		});
		render(ConfirmDialog);

		await user.click(screen.getByLabelText('Forget memory'));
		await tick();
		await user.click(screen.getByRole('button', { name: 'Forget' }));

		expect(fetchMock).toHaveBeenCalledTimes(1);
		const [url, init] = fetchMock.mock.calls[0];
		expect(url).toBe('/api/user/memories/m1');
		expect((init as RequestInit | undefined)?.method).toBe('DELETE');
		// Scoped invalidate avoids re-running the (app) layout load —
		// the memories change doesn't touch sidebar/picker data.
		expect(invalidateMock).toHaveBeenCalledWith('settings:memories');
	});

	it('does not call fetch when the user cancels', async () => {
		const user = userEvent.setup();
		render(MemoriesPage, {
			props: { data: { memories: [mkMemory({ id: 'm1' })] } },
		});
		render(ConfirmDialog);

		await user.click(screen.getByLabelText('Forget memory'));
		await tick();
		await user.click(screen.getByRole('button', { name: 'Cancel' }));

		expect(fetchMock).not.toHaveBeenCalled();
		expect(invalidateMock).not.toHaveBeenCalled();
	});
});

describe('Memories settings page — Recently tidied section', () => {
	it('is absent when there are no tidied memories', () => {
		render(MemoriesPage, { props: { data: { memories: [mkMemory()], deletedMemories: [] } } });
		expect(screen.queryByText(/Recently tidied/)).toBeNull();
		expect(screen.queryByLabelText('Restore memory')).toBeNull();
	});

	it('is absent when the load omits deletedMemories entirely', () => {
		// Older loads / other call sites may not carry the field — the page
		// defaults it to [] rather than crashing.
		render(MemoriesPage, { props: { data: { memories: [mkMemory()] } } });
		expect(screen.queryByText(/Recently tidied/)).toBeNull();
	});

	it('renders a Restore button and the lineage line per tidied memory', async () => {
		const user = userEvent.setup();
		render(MemoriesPage, {
			props: {
				data: {
					memories: [],
					deletedMemories: [
						mkDeleted({
							id: 'd1',
							content: 'works at Acme',
							supersededByContent: 'now at Globex; previously at Acme',
						}),
						mkDeleted({ id: 'd2', content: 'trip to Japan', supersededByContent: null }),
					],
				},
			},
		});
		// Collapsed by default — expand it (the realistic user flow).
		await user.click(screen.getByText(/Recently tidied \(2\)/));
		expect(screen.getAllByLabelText('Restore memory')).toHaveLength(2);
		// Merge shows the survivor snippet; a plain prune shows "Removed".
		expect(screen.getByText(/Merged into: now at Globex/)).toBeInTheDocument();
		expect(screen.getByText('Removed')).toBeInTheDocument();
	});

	it('POSTs to the restore endpoint and invalidates the memories key — no confirm', async () => {
		const user = userEvent.setup();
		fetchMock.mockResolvedValue(new Response(null, { status: 204 }));
		render(MemoriesPage, {
			props: { data: { memories: [], deletedMemories: [mkDeleted({ id: 'd1' })] } },
		});
		render(ConfirmDialog);

		await user.click(screen.getByText(/Recently tidied \(1\)/));
		await user.click(screen.getByLabelText('Restore memory'));

		// Restore is non-destructive → no ConfirmDialog is opened.
		expect(screen.queryByRole('alertdialog')).toBeNull();
		expect(fetchMock).toHaveBeenCalledTimes(1);
		const [url, init] = fetchMock.mock.calls[0];
		expect(url).toBe('/api/user/memories/d1/restore');
		expect((init as RequestInit | undefined)?.method).toBe('POST');
		expect(invalidateMock).toHaveBeenCalledWith('settings:memories');
	});
});

describe('Memories settings page — Conversation topics', () => {
	it('renders the overview (view-only) when present', () => {
		render(MemoriesPage, {
			props: {
				data: {
					memories: [],
					deletedMemories: [],
					conversationOverview: { overview: '## Work\n- deploy pipeline', updatedAt: Date.now() },
				},
			},
		});
		expect(screen.getByText('Conversation topics')).toBeInTheDocument();
		expect(screen.getByText(/deploy pipeline/)).toBeInTheDocument();
		// View-only — no edit/save affordance in this section.
		expect(screen.queryByRole('button', { name: /save/i })).toBeNull();
		expect(screen.queryByRole('textbox')).toBeNull();
	});

	it('is absent when there is no overview', () => {
		render(MemoriesPage, {
			props: {
				data: {
					memories: [],
					deletedMemories: [],
					conversationOverview: { overview: null, updatedAt: null },
				},
			},
		});
		expect(screen.queryByText('Conversation topics')).toBeNull();
	});
});
