/* @vitest-environment happy-dom */

/**
 * Component test for CanvasPane — the view-only side-by-side document pane.
 * Renders the server-provided HTML, the title + version, wires the close
 * button, and (with more than one canvas) a switcher tab strip.
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

/** Default single-canvas props. */
function props(over: Partial<Parameters<typeof render>[1]['props']> = {}) {
	const d = doc();
	return {
		doc: d,
		docs: [d],
		changed: false,
		onClose: () => {},
		onSwitch: () => {},
		onHighlightSettled: () => {},
		...over,
	};
}

describe('CanvasPane', () => {
	it('renders the title, version, and server HTML', () => {
		render(CanvasPane, { props: props() });
		expect(screen.getByRole('heading', { name: 'My Doc' })).toBeInTheDocument();
		expect(screen.getByText('Version 3')).toBeInTheDocument();
		expect(screen.getByText('body')).toBeInTheDocument();
	});

	it('falls back to "Canvas" when the doc has no title', () => {
		const d = doc({ title: null });
		render(CanvasPane, { props: props({ doc: d, docs: [d] }) });
		expect(screen.getByRole('heading', { name: 'Canvas' })).toBeInTheDocument();
	});

	it('shows an empty-state note when there is no content', () => {
		const d = doc({ contentHtml: null, content: '' });
		render(CanvasPane, { props: props({ doc: d, docs: [d] }) });
		expect(screen.getByText(/empty/i)).toBeInTheDocument();
	});

	it('invokes onClose when the close button is clicked', async () => {
		const onClose = vi.fn();
		const { getByLabelText } = render(CanvasPane, { props: props({ onClose }) });
		getByLabelText('Close canvas').click();
		expect(onClose).toHaveBeenCalledOnce();
	});

	it('shows a switcher tab per canvas when there are several, and switches on click', () => {
		const a = doc({ artifactId: 'a1', title: 'Deck' });
		const b = doc({ artifactId: 'a2', title: 'Talking points' });
		const onSwitch = vi.fn();
		render(CanvasPane, { props: props({ doc: a, docs: [a, b], onSwitch }) });

		const tabs = screen.getAllByRole('tab');
		expect(tabs).toHaveLength(2);
		// The shown doc's tab is selected.
		expect(screen.getByRole('tab', { name: 'Deck' })).toHaveAttribute('aria-selected', 'true');
		expect(screen.getByRole('tab', { name: 'Talking points' })).toHaveAttribute(
			'aria-selected',
			'false',
		);

		screen.getByRole('tab', { name: 'Talking points' }).click();
		expect(onSwitch).toHaveBeenCalledWith('a2');
	});

	it('shows no tabs for a single canvas', () => {
		render(CanvasPane, { props: props() });
		expect(screen.queryAllByRole('tab')).toHaveLength(0);
	});
});
