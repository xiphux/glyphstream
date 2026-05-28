/* @vitest-environment happy-dom */

/**
 * Component test for DeleteConversationDialog.
 *
 * The dialog fetches `/api/conversations/{id}/orphan-media` for the count
 * of associated media (so the "also delete N images and M videos" line
 * doesn't cause a mid-dialog layout shift) before rendering anything.
 * Tests mock `fetch` to return canned counts and wait for the effect's
 * promise chain to resolve before asserting.
 *
 * Counts.images and counts.videos drive the checkbox visibility — zero
 * media means no checkbox at all, so the test plan covers both code
 * paths.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import DeleteConversationDialog from '$lib/components/DeleteConversationDialog.svelte';

const realFetch = globalThis.fetch;

function mockOrphanMedia(counts: { images: number; videos: number }) {
	globalThis.fetch = vi.fn(
		async () =>
			new Response(JSON.stringify(counts), {
				status: 200,
				headers: { 'content-type': 'application/json' }
			})
	) as typeof fetch;
}

afterEach(() => {
	globalThis.fetch = realFetch;
});

describe('DeleteConversationDialog — rendering', () => {
	it('renders nothing when targetId is null', () => {
		render(DeleteConversationDialog, {
			props: { targetId: null, onconfirm: vi.fn() }
		});
		expect(screen.queryByRole('alertdialog')).toBeNull();
	});

	it('renders the dialog once the orphan-media fetch resolves', async () => {
		mockOrphanMedia({ images: 0, videos: 0 });
		render(DeleteConversationDialog, {
			props: { targetId: 'conv-1', onconfirm: vi.fn() }
		});
		// Dialog doesn't render until counts are populated.
		await waitFor(() => {
			expect(screen.getByRole('alertdialog')).toBeInTheDocument();
		});
		expect(screen.getByText('Delete this conversation?')).toBeInTheDocument();
		expect(screen.getByText('This action cannot be undone.')).toBeInTheDocument();
	});

	it('hides the "also delete media" checkbox when there is no media', async () => {
		mockOrphanMedia({ images: 0, videos: 0 });
		render(DeleteConversationDialog, {
			props: { targetId: 'conv-1', onconfirm: vi.fn() }
		});
		await waitFor(() => screen.getByRole('alertdialog'));
		expect(screen.queryByRole('checkbox')).toBeNull();
		expect(screen.queryByText(/Also delete/)).toBeNull();
	});

	it('shows the checkbox unchecked by default when media exists', async () => {
		mockOrphanMedia({ images: 3, videos: 1 });
		render(DeleteConversationDialog, {
			props: { targetId: 'conv-1', onconfirm: vi.fn() }
		});
		await waitFor(() => screen.getByRole('alertdialog'));
		const checkbox = screen.getByRole('checkbox') as HTMLInputElement;
		expect(checkbox).toBeInTheDocument();
		expect(checkbox.checked).toBe(false);
	});

	it('formats the media count text', async () => {
		mockOrphanMedia({ images: 3, videos: 1 });
		render(DeleteConversationDialog, {
			props: { targetId: 'conv-1', onconfirm: vi.fn() }
		});
		await waitFor(() => screen.getByRole('alertdialog'));
		expect(screen.getByText('3 images and 1 video')).toBeInTheDocument();
	});

	it('pluralizes correctly for singular and plural counts', async () => {
		mockOrphanMedia({ images: 1, videos: 2 });
		render(DeleteConversationDialog, {
			props: { targetId: 'conv-1', onconfirm: vi.fn() }
		});
		await waitFor(() => screen.getByRole('alertdialog'));
		expect(screen.getByText('1 image and 2 videos')).toBeInTheDocument();
	});

	it('omits zero-count modalities from the text', async () => {
		mockOrphanMedia({ images: 0, videos: 2 });
		render(DeleteConversationDialog, {
			props: { targetId: 'conv-1', onconfirm: vi.fn() }
		});
		await waitFor(() => screen.getByRole('alertdialog'));
		expect(screen.getByText('2 videos')).toBeInTheDocument();
		expect(screen.queryByText(/image/)).toBeNull();
	});
});

describe('DeleteConversationDialog — actions', () => {
	it('fires onconfirm with (id, false) when Delete is clicked with the checkbox off', async () => {
		mockOrphanMedia({ images: 2, videos: 0 });
		const onconfirm = vi.fn();
		const user = userEvent.setup();
		render(DeleteConversationDialog, {
			props: { targetId: 'conv-42', onconfirm }
		});
		await waitFor(() => screen.getByRole('alertdialog'));
		await user.click(screen.getByRole('button', { name: 'Delete' }));
		expect(onconfirm).toHaveBeenCalledWith('conv-42', false);
	});

	it('fires onconfirm with (id, true) when the checkbox is checked first', async () => {
		mockOrphanMedia({ images: 2, videos: 0 });
		const onconfirm = vi.fn();
		const user = userEvent.setup();
		render(DeleteConversationDialog, {
			props: { targetId: 'conv-42', onconfirm }
		});
		await waitFor(() => screen.getByRole('alertdialog'));
		await user.click(screen.getByRole('checkbox'));
		await user.click(screen.getByRole('button', { name: 'Delete' }));
		expect(onconfirm).toHaveBeenCalledWith('conv-42', true);
	});

	it('closes (without firing onconfirm) when Cancel is clicked', async () => {
		mockOrphanMedia({ images: 0, videos: 0 });
		const onconfirm = vi.fn();
		const user = userEvent.setup();
		render(DeleteConversationDialog, {
			props: { targetId: 'conv-42', onconfirm }
		});
		await waitFor(() => screen.getByRole('alertdialog'));
		await user.click(screen.getByRole('button', { name: 'Cancel' }));
		await waitFor(() => {
			expect(screen.queryByRole('alertdialog')).toBeNull();
		});
		expect(onconfirm).not.toHaveBeenCalled();
	});

	it('closes on Escape without firing onconfirm', async () => {
		mockOrphanMedia({ images: 0, videos: 0 });
		const onconfirm = vi.fn();
		const user = userEvent.setup();
		render(DeleteConversationDialog, {
			props: { targetId: 'conv-42', onconfirm }
		});
		await waitFor(() => screen.getByRole('alertdialog'));
		await user.keyboard('{Escape}');
		await waitFor(() => {
			expect(screen.queryByRole('alertdialog')).toBeNull();
		});
		expect(onconfirm).not.toHaveBeenCalled();
	});

	it('closes on backdrop click without firing onconfirm', async () => {
		mockOrphanMedia({ images: 0, videos: 0 });
		const onconfirm = vi.fn();
		render(DeleteConversationDialog, {
			props: { targetId: 'conv-42', onconfirm }
		});
		await waitFor(() => screen.getByRole('alertdialog'));
		await fireEvent.click(screen.getByRole('alertdialog'));
		await waitFor(() => {
			expect(screen.queryByRole('alertdialog')).toBeNull();
		});
		expect(onconfirm).not.toHaveBeenCalled();
	});

	it('does NOT close when the inner panel is clicked', async () => {
		mockOrphanMedia({ images: 0, videos: 0 });
		const onconfirm = vi.fn();
		const user = userEvent.setup();
		render(DeleteConversationDialog, {
			props: { targetId: 'conv-42', onconfirm }
		});
		await waitFor(() => screen.getByRole('alertdialog'));
		await user.click(screen.getByText('Delete this conversation?'));
		// Brief wait to be sure no async close races us, then assert it's
		// still open.
		await new Promise((r) => setTimeout(r, 20));
		expect(screen.getByRole('alertdialog')).toBeInTheDocument();
	});
});

describe('DeleteConversationDialog — flushes only the requesting fetch', () => {
	it('drops the response from a superseded target', async () => {
		// This guards the fetchToken pattern: if the user re-targets
		// before the first fetch lands, the stale response shouldn't
		// populate the modal.
		let firstResolver!: (counts: { images: number; videos: number }) => void;
		const firstPromise = new Promise<{ images: number; videos: number }>((r) => {
			firstResolver = r;
		});
		const secondCounts = { images: 5, videos: 5 };

		let call = 0;
		globalThis.fetch = vi.fn(async () => {
			call++;
			const body = call === 1 ? await firstPromise : secondCounts;
			return new Response(JSON.stringify(body), {
				status: 200,
				headers: { 'content-type': 'application/json' }
			});
		}) as typeof fetch;

		const { rerender } = render(DeleteConversationDialog, {
			props: { targetId: 'first', onconfirm: vi.fn() }
		});
		// Re-target before resolving the first fetch.
		await rerender({ targetId: 'second', onconfirm: vi.fn() });
		// Resolve the first fetch (stale) — its counts should be ignored.
		firstResolver({ images: 99, videos: 99 });
		// Wait for the second fetch's counts to land instead.
		await waitFor(() => screen.getByRole('alertdialog'));
		expect(screen.getByText('5 images and 5 videos')).toBeInTheDocument();
		expect(screen.queryByText(/99/)).toBeNull();
	});
});
