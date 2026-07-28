/* @vitest-environment happy-dom */

/**
 * Component test for InFlightBubble — the live streaming-response
 * bubble. Read-only: the page owns SSE state and passes derived blocks
 * + status down. Tests cover the placeholder-vs-blocks branch and the
 * placeholder's status/progress/elapsed affordances.
 */

import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/svelte';
import InFlightBubble from '$lib/components/chat/InFlightBubble.svelte';
import type { RenderBlock } from '$lib/chat-render';

const base = {
	assistantLabel: 'gpt-4o',
	label: 'Thinking',
	status: null as string | null,
	progress: null as number | null,
	elapsedSeconds: 0,
	onImageClick: vi.fn(),
};

describe('InFlightBubble — placeholder (no blocks yet)', () => {
	it('shows the label verb while waiting for the first token', () => {
		render(InFlightBubble, { props: { ...base, blocks: [] } });
		expect(screen.getByText('Thinking')).toBeInTheDocument();
	});

	it('shows the assistant label header', () => {
		render(InFlightBubble, { props: { ...base, blocks: [] } });
		expect(screen.getByText('gpt-4o')).toBeInTheDocument();
	});

	// `status` is display text supplied by the server (see StreamProgressEvent):
	// a sub-phase worth naming, or absent for plain "it's generating". The badge
	// renders it verbatim — no client-side filtering of provider enums, which is
	// enforced at the emitter instead (video-relay's PHASE_LABELS map).
	it('shows the status badge when a sub-phase is named', () => {
		render(InFlightBubble, { props: { ...base, blocks: [], status: 'Enhancing prompt…' } });
		expect(screen.getByText('Enhancing prompt…')).toBeInTheDocument();
	});

	it('shows no status badge when there is no sub-phase', () => {
		const { container } = render(InFlightBubble, { props: { ...base, blocks: [], status: null } });
		expect(container.querySelector('.bg-surface-sunken')).toBeNull();
	});

	it('shows progress percent when set', () => {
		render(InFlightBubble, { props: { ...base, blocks: [], progress: 42.7 } });
		expect(screen.getByText('43%')).toBeInTheDocument();
	});

	it('shows elapsed seconds once past the 0.3s threshold', () => {
		render(InFlightBubble, { props: { ...base, blocks: [], elapsedSeconds: 1.2 } });
		expect(screen.getByText('1.2s')).toBeInTheDocument();
	});

	it('hides elapsed seconds below the threshold', () => {
		render(InFlightBubble, { props: { ...base, blocks: [], elapsedSeconds: 0.1 } });
		expect(screen.queryByText(/0\.\ds/)).toBeNull();
	});

	it('uses the supplied generating label for image/video', () => {
		render(InFlightBubble, {
			props: { ...base, blocks: [], label: 'Generating image' },
		});
		expect(screen.getByText('Generating image')).toBeInTheDocument();
	});
});

describe('InFlightBubble — with blocks', () => {
	it('renders blocks and drops the placeholder once content arrives', () => {
		const blocks: RenderBlock[] = [{ type: 'plain-text', text: 'streaming answer' }];
		render(InFlightBubble, { props: { ...base, blocks } });
		expect(screen.getByText('streaming answer')).toBeInTheDocument();
		// Placeholder verb is gone once blocks render.
		expect(screen.queryByText('Thinking')).toBeNull();
	});

	it('renders a tool_call block via RenderBlocks', () => {
		const blocks: RenderBlock[] = [
			{
				type: 'tool_call',
				toolCallId: 'tc-1',
				toolName: 'web_search',
				arguments: '{"query":"x"}',
				status: 'executing',
			},
		];
		render(InFlightBubble, { props: { ...base, blocks } });
		expect(screen.getByText('web_search')).toBeInTheDocument();
		expect(screen.getByText('running')).toBeInTheDocument();
	});

	it('renders a canvas card (not a blank bubble) when create_canvas is the only in-flight block', () => {
		// Regression: canvas success cards are stripped from RenderBlocks' body and
		// hoisted; without InFlightBubble rendering them, a create_canvas-first turn
		// streamed into an empty bubble with just the label.
		const blocks: RenderBlock[] = [
			{
				type: 'tool_call',
				toolCallId: 'c1',
				toolName: 'create_canvas',
				arguments: '{"title":"Doc"',
				status: 'executing',
			},
		];
		render(InFlightBubble, { props: { ...base, blocks } });
		// The pending canvas card shows, and the "Thinking" placeholder does not.
		expect(screen.getByText(/working/i)).toBeInTheDocument();
		expect(screen.queryByText('Thinking')).toBeNull();
	});
});
