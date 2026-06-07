/* @vitest-environment happy-dom */

/**
 * Component test for AttachmentThumbnails.
 *
 * The component reads `attachments.items` and calls `attachments.remove(id)`.
 * We use a minimal stand-in store that exposes just those two — building a
 * real AttachmentStore would drag in encodeJpeg / URL.createObjectURL paths
 * that aren't relevant to what the component renders.
 */

import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import AttachmentThumbnails from '$lib/components/AttachmentThumbnails.svelte';
import type { AttachedItem, AttachmentStore } from '$lib/attachments.svelte';

function makeItem(overrides: Partial<AttachedItem> = {}): AttachedItem {
	return {
		clientId: overrides.clientId ?? 'c-' + Math.random().toString(36).slice(2, 8),
		mediaId: overrides.mediaId ?? 'm-' + Math.random().toString(36).slice(2, 8),
		objectUrl: overrides.objectUrl ?? 'blob:http://localhost/abc-123',
		contentType: overrides.contentType ?? 'image/png',
		byteSize: overrides.byteSize ?? 12345,
		kind: overrides.kind ?? 'image',
		filename: overrides.filename,
		status: overrides.status ?? 'ready',
		error: overrides.error,
	};
}

function makeStore(items: AttachedItem[], remove = vi.fn()): AttachmentStore {
	// Use $state for items so the component's reactivity sees mutations,
	// though most tests don't need to mutate after render.
	return { items, remove } as unknown as AttachmentStore;
}

describe('AttachmentThumbnails — rendering', () => {
	it('renders nothing when there are no items', () => {
		render(AttachmentThumbnails, {
			props: { attachments: makeStore([]) },
		});
		expect(screen.queryByRole('img')).toBeNull();
		expect(screen.queryByRole('button', { name: 'Remove attachment' })).toBeNull();
	});

	it('renders one img per item, with the objectUrl as src', () => {
		const items = [
			makeItem({ clientId: 'a', objectUrl: 'blob:http://localhost/a' }),
			makeItem({ clientId: 'b', objectUrl: 'blob:http://localhost/b' }),
		];
		// Thumbnails use alt="" (decorative) so they're excluded from the
		// a11y tree — query via the DOM directly.
		const { container } = render(AttachmentThumbnails, {
			props: { attachments: makeStore(items) },
		});
		const imgs = container.querySelectorAll('img');
		expect(imgs).toHaveLength(2);
		expect(imgs[0]).toHaveAttribute('src', 'blob:http://localhost/a');
		expect(imgs[1]).toHaveAttribute('src', 'blob:http://localhost/b');
	});

	it('renders the per-item remove button (one per attachment)', () => {
		const items = [makeItem({ clientId: 'a' }), makeItem({ clientId: 'b' })];
		render(AttachmentThumbnails, { props: { attachments: makeStore(items) } });
		expect(screen.getAllByRole('button', { name: 'Remove attachment' })).toHaveLength(2);
	});

	it('applies the supplied wrapper class', () => {
		const items = [makeItem()];
		const { container } = render(AttachmentThumbnails, {
			props: { attachments: makeStore(items), class: 'mb-2' },
		});
		expect(container.querySelector('.mb-2')).toBeInTheDocument();
	});
});

describe('AttachmentThumbnails — status overlays', () => {
	it('shows no overlay on ready items', () => {
		const { container } = render(AttachmentThumbnails, {
			props: { attachments: makeStore([makeItem({ status: 'ready' })]) },
		});
		// Spinner uses animate-spin; error overlay shows AlertCircle (svg)
		// — neither should be present.
		expect(container.querySelector('.animate-spin')).toBeNull();
	});

	it('shows a spinner overlay while uploading', () => {
		const { container } = render(AttachmentThumbnails, {
			props: { attachments: makeStore([makeItem({ status: 'uploading' })]) },
		});
		expect(container.querySelector('.animate-spin')).toBeInTheDocument();
	});

	it('shows an error overlay on error', () => {
		const { container } = render(AttachmentThumbnails, {
			props: {
				attachments: makeStore([makeItem({ status: 'error', error: 'upload rejected' })]),
			},
		});
		// Error overlay has a danger-tinted background class.
		expect(container.querySelector('.bg-danger\\/40')).toBeInTheDocument();
	});

	it('uses the error message in the wrapper title attribute', () => {
		const { container } = render(AttachmentThumbnails, {
			props: {
				attachments: makeStore([
					makeItem({
						status: 'error',
						error: 'File too large',
						contentType: 'image/png',
					}),
				]),
			},
		});
		const wrapper = container.querySelector('[title="File too large"]');
		expect(wrapper).toBeInTheDocument();
	});

	it('falls back to contentType in title when no error', () => {
		const { container } = render(AttachmentThumbnails, {
			props: {
				attachments: makeStore([makeItem({ contentType: 'image/jpeg', status: 'ready' })]),
			},
		});
		expect(container.querySelector('[title="image/jpeg"]')).toBeInTheDocument();
	});

	it('dims the img while uploading', () => {
		const { container } = render(AttachmentThumbnails, {
			props: { attachments: makeStore([makeItem({ status: 'uploading' })]) },
		});
		const img = container.querySelector('img')!;
		expect(img).toHaveClass('opacity-60');
	});

	it('dims the img more aggressively on error', () => {
		const { container } = render(AttachmentThumbnails, {
			props: { attachments: makeStore([makeItem({ status: 'error' })]) },
		});
		const img = container.querySelector('img')!;
		expect(img).toHaveClass('opacity-40');
	});
});

describe('AttachmentThumbnails — remove', () => {
	it('calls remove(clientId) when the X button is clicked', async () => {
		const user = userEvent.setup();
		const remove = vi.fn();
		const items = [makeItem({ clientId: 'target-abc' })];
		render(AttachmentThumbnails, { props: { attachments: makeStore(items, remove) } });
		await user.click(screen.getByRole('button', { name: 'Remove attachment' }));
		expect(remove).toHaveBeenCalledWith('target-abc');
	});

	it('passes the correct clientId for each thumbnail', async () => {
		const user = userEvent.setup();
		const remove = vi.fn();
		const items = [
			makeItem({ clientId: 'first' }),
			makeItem({ clientId: 'second' }),
			makeItem({ clientId: 'third' }),
		];
		render(AttachmentThumbnails, { props: { attachments: makeStore(items, remove) } });
		const buttons = screen.getAllByRole('button', { name: 'Remove attachment' });
		await user.click(buttons[1]);
		expect(remove).toHaveBeenCalledWith('second');
		expect(remove).toHaveBeenCalledTimes(1);
	});
});
