/* @vitest-environment happy-dom */

/**
 * Component test for MessageBubble — static render of one persisted
 * message. Role drives bubble styling + label; merge flags collapse
 * consecutive assistant rows. Body delegated to RenderBlocks (covered
 * by its own test), so here we assert the bubble shell + label + that
 * RenderBlocks gets the message's content through messageToBlocks.
 */

import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import MessageBubble from '$lib/components/chat/MessageBubble.svelte';
import type { ChatMessage, MessagePart, MessageRole } from '$lib/types/api';

function makeMessage(
	role: MessageRole,
	parts: MessagePart[],
	overrides: Partial<ChatMessage> = {},
): ChatMessage {
	return {
		id: overrides.id ?? 'm-1',
		role,
		parts,
		contentHtml: overrides.contentHtml ?? null,
		reasoningText: overrides.reasoningText ?? null,
		finishReason: null,
		modelUsed: null,
		tokensIn: null,
		tokensOut: null,
		genMs: null,
		createdAt: 0,
		...overrides,
	};
}

const baseProps = {
	toolResultsByCallId: new Map(),
	userLabel: 'Chris',
	assistantLabel: 'gpt-4o',
	mergeWithPrev: false,
	mergeWithNext: false,
	onImageClick: vi.fn(),
};

describe('MessageBubble — role label', () => {
	it('shows the user label for user messages', () => {
		render(MessageBubble, {
			props: {
				...baseProps,
				message: makeMessage('user', [{ type: 'text', text: 'hello' }]),
			},
		});
		expect(screen.getByText('Chris')).toBeInTheDocument();
		expect(screen.getByText('hello')).toBeInTheDocument();
	});

	it('shows the assistant label for assistant messages', () => {
		render(MessageBubble, {
			props: {
				...baseProps,
				message: makeMessage('assistant', [{ type: 'text', text: 'hi there' }]),
			},
		});
		expect(screen.getByText('gpt-4o')).toBeInTheDocument();
	});

	it('hides the role label when mergeWithPrev is true', () => {
		render(MessageBubble, {
			props: {
				...baseProps,
				mergeWithPrev: true,
				message: makeMessage('assistant', [{ type: 'text', text: 'continued' }]),
			},
		});
		expect(screen.queryByText('gpt-4o')).toBeNull();
		expect(screen.getByText('continued')).toBeInTheDocument();
	});
});

describe('MessageBubble — bubble styling', () => {
	it('right-aligns + accent-tints user bubbles', () => {
		const { container } = render(MessageBubble, {
			props: {
				...baseProps,
				message: makeMessage('user', [{ type: 'text', text: 'x' }]),
			},
		});
		const article = container.querySelector('article')!;
		expect(article).toHaveClass('ml-auto');
		expect(article).toHaveClass('bg-accent/15');
	});

	it('light-tints assistant bubbles', () => {
		const { container } = render(MessageBubble, {
			props: {
				...baseProps,
				message: makeMessage('assistant', [{ type: 'text', text: 'x' }]),
			},
		});
		expect(container.querySelector('article')).toHaveClass('bg-surface-raised');
	});

	it('warning-tints tool bubbles', () => {
		const { container } = render(MessageBubble, {
			props: {
				...baseProps,
				message: makeMessage('tool', [{ type: 'text', text: 'x' }]),
			},
		});
		expect(container.querySelector('article')).toHaveClass('bg-warning/10');
	});

	it('collapses top corners + padding when mergeWithPrev', () => {
		const { container } = render(MessageBubble, {
			props: {
				...baseProps,
				mergeWithPrev: true,
				message: makeMessage('assistant', [{ type: 'text', text: 'x' }]),
			},
		});
		expect(container.querySelector('article')).toHaveClass('rounded-t-none');
	});

	it('collapses bottom corners + padding when mergeWithNext', () => {
		const { container } = render(MessageBubble, {
			props: {
				...baseProps,
				mergeWithNext: true,
				message: makeMessage('assistant', [{ type: 'text', text: 'x' }]),
			},
		});
		expect(container.querySelector('article')).toHaveClass('rounded-b-none');
	});
});

describe('MessageBubble — body rendering', () => {
	it('renders server HTML when present', () => {
		const { container } = render(MessageBubble, {
			props: {
				...baseProps,
				message: makeMessage('assistant', [{ type: 'text', text: 'raw' }], {
					contentHtml: '<p>rendered <code>html</code></p>',
				}),
			},
		});
		expect(container.querySelector('.gs-prose code')?.textContent).toBe('html');
	});

	it('renders a reasoning block when reasoningText is set', () => {
		render(MessageBubble, {
			props: {
				...baseProps,
				message: makeMessage('assistant', [{ type: 'text', text: 'answer' }], {
					reasoningText: 'let me think',
				}),
			},
		});
		expect(screen.getByText('Reasoning')).toBeInTheDocument();
		expect(screen.getByText('let me think')).toBeInTheDocument();
	});
});

describe('MessageBubble — preset avatar', () => {
	// The avatar is presentational duplication of the label, so it's queried
	// by role+title rather than alt text: `alt` is deliberately empty so screen
	// readers hear the name once, from the label beside it.
	const avatar = () => document.querySelector('img[src^="/api/media/"]');

	it('renders the avatar beside the label when the message has one', () => {
		render(MessageBubble, {
			props: {
				...baseProps,
				assistantLabel: 'Ilya',
				assistantAvatarMediaId: 'media-7',
				message: makeMessage('assistant', [{ type: 'text', text: 'hi' }]),
			},
		});
		expect(screen.getByText('Ilya')).toBeInTheDocument();
		expect(avatar()).toHaveAttribute('src', '/api/media/media-7/thumbnail');
		// Empty alt: the label sits beside it, so announcing the name twice is
		// noise. The accessible name lives on the wrapping button instead.
		expect(avatar()).toHaveAttribute('alt', '');
		expect(screen.getByRole('button', { name: 'View avatar' })).toHaveAttribute('title', 'Ilya');
	});

	it('opens the lightbox for the avatar when clicked', async () => {
		// Same handler the inline generated images use — an avatar IS a media
		// row, so clicking it should behave like clicking any other image.
		const user = userEvent.setup();
		const onImageClick = vi.fn();
		render(MessageBubble, {
			props: {
				...baseProps,
				onImageClick,
				assistantLabel: 'Ilya',
				assistantAvatarMediaId: 'media-7',
				message: makeMessage('assistant', [{ type: 'text', text: 'hi' }]),
			},
		});

		await user.click(screen.getByRole('button', { name: 'View avatar' }));
		expect(onImageClick).toHaveBeenCalledWith('media-7');
	});

	it('renders label-only when there is no avatar', () => {
		render(MessageBubble, {
			props: {
				...baseProps,
				assistantLabel: 'gpt-4o',
				message: makeMessage('assistant', [{ type: 'text', text: 'hi' }]),
			},
		});
		expect(screen.getByText('gpt-4o')).toBeInTheDocument();
		expect(avatar()).toBeNull();
	});

	it('suppresses the avatar on a merged continuation row', () => {
		// A multi-iteration tool turn renders as ONE bubble; repeating the
		// portrait mid-bubble would read as a second speaker joining in.
		render(MessageBubble, {
			props: {
				...baseProps,
				assistantLabel: 'Ilya',
				assistantAvatarMediaId: 'media-7',
				mergeWithPrev: true,
				message: makeMessage('assistant', [{ type: 'text', text: 'continued' }]),
			},
		});
		expect(screen.queryByText('Ilya')).not.toBeInTheDocument();
		expect(avatar()).toBeNull();
	});

	it('never puts the avatar on a non-assistant row', () => {
		// Belt-and-braces against a caller passing the conversation's avatar
		// down indiscriminately: a tool row borrows neither name nor face.
		render(MessageBubble, {
			props: {
				...baseProps,
				assistantAvatarMediaId: 'media-7',
				message: makeMessage('tool', [{ type: 'text', text: 'result' }]),
			},
		});
		expect(avatar()).toBeNull();
	});
});
