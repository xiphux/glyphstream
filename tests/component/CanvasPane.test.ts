/* @vitest-environment happy-dom */

/**
 * Component test for CanvasPane — the view-only side-by-side document pane.
 * Renders the server-provided HTML, the title + version, and wires the close
 * button.
 */

import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/svelte';
import CanvasPane from '$lib/components/chat/CanvasPane.svelte';
import type { CanvasVersion } from '$lib/types/api';

function doc(overrides: Partial<CanvasVersion> = {}): CanvasVersion {
	return {
		artifactId: 'a1',
		versionId: 'v1',
		title: 'My Doc',
		content: '# Heading\n\nbody',
		contentHtml: '<h1>Heading</h1>\n<p>body</p>',
		versionNumber: 3,
		editSource: 'agent',
		...overrides,
	};
}

describe('CanvasPane', () => {
	it('renders the title, version, and server HTML', () => {
		render(CanvasPane, {
			props: { doc: doc(), changed: false, onClose: () => {}, onHighlightSettled: () => {} },
		});
		expect(screen.getByRole('heading', { name: 'My Doc' })).toBeInTheDocument();
		expect(screen.getByText('Version 3')).toBeInTheDocument();
		expect(screen.getByText('body')).toBeInTheDocument();
	});

	it('falls back to "Canvas" when the doc has no title', () => {
		render(CanvasPane, {
			props: {
				doc: doc({ title: null }),
				changed: false,
				onClose: () => {},
				onHighlightSettled: () => {},
			},
		});
		expect(screen.getByRole('heading', { name: 'Canvas' })).toBeInTheDocument();
	});

	it('shows an empty-state note when there is no content', () => {
		render(CanvasPane, {
			props: {
				doc: doc({ contentHtml: null, content: '' }),
				changed: false,
				onClose: () => {},
				onHighlightSettled: () => {},
			},
		});
		expect(screen.getByText(/empty/i)).toBeInTheDocument();
	});

	it('invokes onClose when the close button is clicked', async () => {
		const onClose = vi.fn();
		const { getByLabelText } = render(CanvasPane, {
			props: { doc: doc(), changed: false, onClose, onHighlightSettled: () => {} },
		});
		getByLabelText('Close canvas').click();
		expect(onClose).toHaveBeenCalledOnce();
	});
});
