/* @vitest-environment happy-dom */

/**
 * Component test for RenderBlocks — the shared render-loop for chat
 * bubbles (used by both MessageBubble and InFlightBubble). Branches on
 * RenderBlock.type; the block shapes come from chat-render.ts.
 */

import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import RenderBlocks from '$lib/components/chat/RenderBlocks.svelte';
import type { RenderBlock } from '$lib/chat-render';

function renderBlocks(
	blocks: RenderBlock[],
	onImageClick = vi.fn(),
	openingLightboxFor: string | null = null,
) {
	return render(RenderBlocks, { props: { blocks, onImageClick, openingLightboxFor } });
}

describe('RenderBlocks — reasoning', () => {
	it('renders a Reasoning details block with the text', () => {
		const { container } = renderBlocks([{ type: 'reasoning', text: 'thinking hard', open: false }]);
		expect(screen.getByText('Reasoning')).toBeInTheDocument();
		expect(screen.getByText('thinking hard')).toBeInTheDocument();
		expect(container.querySelector('details')!.open).toBe(false);
	});

	it('renders open when block.open is true', () => {
		const { container } = renderBlocks([{ type: 'reasoning', text: 'live thinking', open: true }]);
		expect(container.querySelector('details')!.open).toBe(true);
	});
});

describe('RenderBlocks — html + plain-text', () => {
	it('renders html blocks via {@html}', () => {
		const { container } = renderBlocks([
			{ type: 'html', html: '<p>hello <strong>world</strong></p>' },
		]);
		expect(container.querySelector('.gs-prose strong')?.textContent).toBe('world');
	});

	it('renders plain-text blocks as text', () => {
		renderBlocks([{ type: 'plain-text', text: 'just words' }]);
		expect(screen.getByText('just words')).toBeInTheDocument();
	});
});

describe('RenderBlocks — tool_call', () => {
	it('renders a ToolCallBlock for tool_call blocks', () => {
		renderBlocks([
			{
				type: 'tool_call',
				toolCallId: 'tc-1',
				toolName: 'get_current_time',
				arguments: '{}',
				result: '{"iso":"2026-01-01"}',
				status: 'done',
			},
		]);
		// ToolCallBlock renders the tool name + TOOL label.
		expect(screen.getByText('get_current_time')).toBeInTheDocument();
		expect(screen.getByText('Tool')).toBeInTheDocument();
	});
});

describe('RenderBlocks — image', () => {
	it('renders an image with the content-endpoint src', () => {
		const { container } = renderBlocks([{ type: 'image', mediaId: 'img-1', alt: 'a cat' }]);
		const img = container.querySelector('img')!;
		expect(img).toHaveAttribute('src', '/api/media/img-1/content');
		expect(img).toHaveAttribute('alt', 'a cat');
	});

	it('falls back to "Image" alt when none supplied', () => {
		const { container } = renderBlocks([{ type: 'image', mediaId: 'img-1' }]);
		expect(container.querySelector('img')).toHaveAttribute('alt', 'Image');
	});

	it('calls onImageClick with the media id when clicked', async () => {
		const user = userEvent.setup();
		const onImageClick = vi.fn();
		renderBlocks([{ type: 'image', mediaId: 'img-7' }], onImageClick);
		await user.click(screen.getByRole('button', { name: 'Open image' }));
		expect(onImageClick).toHaveBeenCalledWith('img-7');
	});

	it('disables the image button while that media is opening', () => {
		renderBlocks([{ type: 'image', mediaId: 'img-7' }], vi.fn(), 'img-7');
		expect(screen.getByRole('button', { name: 'Open image' })).toBeDisabled();
	});

	it('does not disable the button for a different opening id', () => {
		renderBlocks([{ type: 'image', mediaId: 'img-7' }], vi.fn(), 'other');
		expect(screen.getByRole('button', { name: 'Open image' })).not.toBeDisabled();
	});
});

describe('RenderBlocks — video', () => {
	it('renders a video with the content-endpoint src + controls', () => {
		const { container } = renderBlocks([{ type: 'video', mediaId: 'vid-1' }]);
		const video = container.querySelector('video')!;
		expect(video).toHaveAttribute('src', '/api/media/vid-1/content');
		expect(video).toHaveAttribute('controls');
	});
});

describe('RenderBlocks — multiple blocks', () => {
	it('renders blocks in order, interleaving text and tool calls', () => {
		const { container } = renderBlocks([
			{ type: 'plain-text', text: 'before' },
			{
				type: 'tool_call',
				toolCallId: 'tc-1',
				toolName: 'search',
				arguments: '{}',
				status: 'done',
			},
			{ type: 'plain-text', text: 'after' },
		]);
		const text = container.textContent ?? '';
		expect(text.indexOf('before')).toBeLessThan(text.indexOf('search'));
		expect(text.indexOf('search')).toBeLessThan(text.indexOf('after'));
	});

	it('renders nothing for an empty block list', () => {
		const { container } = renderBlocks([]);
		expect(container.querySelector('img, video, details, .gs-prose')).toBeNull();
	});
});
