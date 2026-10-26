/**
 * Component test for RenderBlocks — the shared render-loop for chat
 * bubbles (used by both MessageBubble and InFlightBubble). Branches on
 * RenderBlock.type; the block shapes come from chat-render.ts.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import RenderBlocks from '#lib/components/chat/RenderBlocks.svelte';
import type { RenderBlock } from '#lib/chat-render.js';

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

describe('RenderBlocks — code copy button', () => {
	// happy-dom leaves isSecureContext undefined — the plain-http case; the
	// tests of the async clipboard path need a secure one.
	// happy-dom has no execCommand; tests that need one install a stub.
	const realExecCommand = Object.getOwnPropertyDescriptor(document, 'execCommand');
	beforeEach(() => {
		vi.stubGlobal('isSecureContext', true);
	});
	afterEach(() => {
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
		if (realExecCommand) Object.defineProperty(document, 'execCommand', realExecCommand);
		else delete (document as { execCommand?: unknown }).execCommand;
	});

	const shiki =
		'<p>here:</p><pre class="shiki" tabindex="0"><code><span class="line"><span>line one</span></span>\n<span class="line"><span>line two</span></span></code></pre>';

	it('puts a copy button beside each code block, outside the <pre>', () => {
		const { container } = renderBlocks([
			{ type: 'html', html: shiki + '<pre><code class="language-text">plain\n</code></pre>' },
		]);
		const wrappers = container.querySelectorAll('.gs-prose .gs-code');
		expect(wrappers).toHaveLength(2);
		for (const w of wrappers) {
			expect(w.querySelector(':scope > button.gs-code-copy')).not.toBeNull();
			expect(w.querySelector('pre button')).toBeNull();
		}
	});

	it('omits the buttons when codeCopy is off', () => {
		const { container } = render(RenderBlocks, {
			props: {
				blocks: [{ type: 'html', html: '<pre><code>x\n</code></pre>' }],
				onImageClick: vi.fn(),
				codeCopy: false,
			},
		});
		expect(container.querySelector('pre')).not.toBeNull();
		expect(container.querySelector('.gs-code')).toBeNull();
	});

	it('leaves prose without code blocks untouched', () => {
		const { container } = renderBlocks([
			{ type: 'html', html: '<p>no <code>inline</code> blocks</p>' },
		]);
		expect(container.querySelector('.gs-code-copy')).toBeNull();
	});

	it('copies the block text without the trailing newline', async () => {
		const user = userEvent.setup();
		const writeText = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue();
		renderBlocks([
			{
				type: 'html',
				html: '<pre><code class="language-markdown"># Title\n\n- item\n</code></pre>',
			},
		]);
		const button = screen.getByRole('button', { name: 'Copy code' });
		await user.click(button);
		expect(writeText).toHaveBeenCalledWith('# Title\n\n- item');
		expect(button).toHaveAttribute('data-copied');
		expect(button).toHaveAccessibleName('Copied');
	});

	it('falls back to execCommand where the clipboard API is missing (plain http)', async () => {
		const user = userEvent.setup();
		const writeText = vi.spyOn(navigator.clipboard, 'writeText');
		vi.stubGlobal('isSecureContext', false);
		let copied: string | null = null;
		document.execCommand = vi.fn((cmd: string) => {
			if (cmd === 'copy') copied = document.querySelector('textarea')?.value ?? null;
			return true;
		});
		renderBlocks([{ type: 'html', html: '<pre><code>raw text\n</code></pre>' }]);
		const button = screen.getByRole('button', { name: 'Copy code' });
		await user.click(button);
		expect(writeText).not.toHaveBeenCalled();
		expect(copied).toBe('raw text');
		expect(button).toHaveAttribute('data-copied');
		expect(document.querySelector('textarea')).toBeNull();
	});

	it('selects the block when nothing can write the clipboard', async () => {
		const user = userEvent.setup();
		vi.spyOn(navigator.clipboard, 'writeText').mockRejectedValue(new Error('denied'));
		vi.spyOn(console, 'warn').mockImplementation(() => {});
		document.execCommand = vi.fn(() => false);
		renderBlocks([{ type: 'html', html: '<pre><code>raw text\n</code></pre>' }]);
		const button = screen.getByRole('button', { name: 'Copy code' });
		await user.click(button);
		expect(button).not.toHaveAttribute('data-copied');
		expect(window.getSelection()?.toString()).toContain('raw text');
	});

	it('copies multi-line shiki output as plain text', async () => {
		const user = userEvent.setup();
		const writeText = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue();
		renderBlocks([{ type: 'html', html: shiki }]);
		await user.click(screen.getByRole('button', { name: 'Copy code' }));
		expect(writeText).toHaveBeenCalledWith('line one\nline two');
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
	it('renders an image from its display-sized copy', () => {
		const { container } = renderBlocks([{ type: 'image', mediaId: 'img-1', alt: 'a cat' }]);
		const img = container.querySelector('img')!;
		expect(img).toHaveAttribute('src', '/api/media/img-1/display');
		expect(img).toHaveAttribute('alt', 'a cat');
	});

	it('reserves the stored aspect ratio so the thread does not jump on load', () => {
		const { container } = renderBlocks([{ type: 'image', mediaId: 'img-1', aspectRatio: '16:9' }]);
		expect(container.querySelector('img')!.style.aspectRatio).toBe('16 / 9');
	});

	it('prefers the measured size over the upstream label', () => {
		// A ratio label is approximate — SDXL's "16:9" bucket is 1344 × 768, which
		// is 7:4 — and the box has to match the pixels, not the label.
		const { container } = renderBlocks([
			{ type: 'image', mediaId: 'img-1', aspectRatio: '16:9', width: 1344, height: 768 },
		]);
		expect(container.querySelector('img')!.style.aspectRatio).toBe('1344 / 768');
	});

	it('reserves nothing without a valid ratio', () => {
		const { container } = renderBlocks([
			{ type: 'image', mediaId: 'img-1' },
			{ type: 'image', mediaId: 'img-2', aspectRatio: 'wide' },
		]);
		for (const img of container.querySelectorAll('img')) expect(img.style.aspectRatio).toBe('');
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
