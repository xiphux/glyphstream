/* @vitest-environment happy-dom */

/**
 * Component test for CanvasCard — the inline clickable reference to a canvas
 * that renders in the conversation and reopens the pane.
 */

import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/svelte';
import CanvasCard from '$lib/components/chat/CanvasCard.svelte';

const ack = (o: Record<string, unknown>) => JSON.stringify(o);

describe('CanvasCard', () => {
	it('shows the title from the ack and opens with the artifactId (no version label)', () => {
		const onOpen = vi.fn();
		render(CanvasCard, {
			props: {
				result: ack({ ok: true, artifactId: 'art_1', version: 2, title: 'My Doc' }),
				onOpen,
			},
		});
		expect(screen.getByText('My Doc')).toBeInTheDocument();
		expect(screen.getByText(/open canvas/i)).toBeInTheDocument();
		// Phase 1 opens current state, so no misleading version number on the card.
		expect(screen.queryByText(/v2|version 2/i)).toBeNull();
		screen.getByRole('button').click();
		expect(onOpen).toHaveBeenCalledWith('art_1');
	});

	it('falls back to "Canvas" when the ack has no title', () => {
		render(CanvasCard, { props: { result: ack({ ok: true, version: 1 }) } });
		expect(screen.getByText('Canvas')).toBeInTheDocument();
	});

	it('renders a disabled working state while the tool is still executing', () => {
		render(CanvasCard, { props: { result: undefined } });
		expect(screen.getByText(/working/i)).toBeInTheDocument();
		expect(screen.getByRole('button')).toBeDisabled();
	});

	it('shows a quiet note (no open affordance) when the edit failed', () => {
		render(CanvasCard, {
			props: { result: ack({ error: 'old_str was not found in the canvas.' }) },
		});
		expect(screen.getByText(/didn't apply/i)).toBeInTheDocument();
		expect(screen.queryByRole('button')).toBeNull();
	});
});
