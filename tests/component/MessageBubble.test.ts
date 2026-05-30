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
import MessageBubble from '$lib/components/chat/MessageBubble.svelte';
import type { ChatMessage, MessagePart, MessageRole } from '$lib/types/api';

function makeMessage(role: MessageRole, parts: MessagePart[], overrides: Partial<ChatMessage> = {}): ChatMessage {
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
		createdAt: 0,
		...overrides
	};
}

const baseProps = {
	toolResultsByCallId: new Map(),
	userLabel: 'Chris',
	assistantLabel: 'gpt-4o',
	mergeWithPrev: false,
	mergeWithNext: false,
	onImageClick: vi.fn()
};

describe('MessageBubble — role label', () => {
	it('shows the user label for user messages', () => {
		render(MessageBubble, {
			props: {
				...baseProps,
				message: makeMessage('user', [{ type: 'text', text: 'hello' }])
			}
		});
		expect(screen.getByText('Chris')).toBeInTheDocument();
		expect(screen.getByText('hello')).toBeInTheDocument();
	});

	it('shows the assistant label for assistant messages', () => {
		render(MessageBubble, {
			props: {
				...baseProps,
				message: makeMessage('assistant', [{ type: 'text', text: 'hi there' }])
			}
		});
		expect(screen.getByText('gpt-4o')).toBeInTheDocument();
	});

	it('hides the role label when mergeWithPrev is true', () => {
		render(MessageBubble, {
			props: {
				...baseProps,
				mergeWithPrev: true,
				message: makeMessage('assistant', [{ type: 'text', text: 'continued' }])
			}
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
				message: makeMessage('user', [{ type: 'text', text: 'x' }])
			}
		});
		const article = container.querySelector('article')!;
		expect(article).toHaveClass('ml-auto');
		expect(article).toHaveClass('bg-accent/15');
	});

	it('light-tints assistant bubbles', () => {
		const { container } = render(MessageBubble, {
			props: {
				...baseProps,
				message: makeMessage('assistant', [{ type: 'text', text: 'x' }])
			}
		});
		expect(container.querySelector('article')).toHaveClass('bg-surface-raised');
	});

	it('amber-tints tool bubbles', () => {
		const { container } = render(MessageBubble, {
			props: {
				...baseProps,
				message: makeMessage('tool', [{ type: 'text', text: 'x' }])
			}
		});
		expect(container.querySelector('article')).toHaveClass('bg-amber-50');
	});

	it('collapses top corners + padding when mergeWithPrev', () => {
		const { container } = render(MessageBubble, {
			props: {
				...baseProps,
				mergeWithPrev: true,
				message: makeMessage('assistant', [{ type: 'text', text: 'x' }])
			}
		});
		expect(container.querySelector('article')).toHaveClass('rounded-t-none');
	});

	it('collapses bottom corners + padding when mergeWithNext', () => {
		const { container } = render(MessageBubble, {
			props: {
				...baseProps,
				mergeWithNext: true,
				message: makeMessage('assistant', [{ type: 'text', text: 'x' }])
			}
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
					contentHtml: '<p>rendered <code>html</code></p>'
				})
			}
		});
		expect(container.querySelector('.gs-prose code')?.textContent).toBe('html');
	});

	it('renders a reasoning block when reasoningText is set', () => {
		render(MessageBubble, {
			props: {
				...baseProps,
				message: makeMessage('assistant', [{ type: 'text', text: 'answer' }], {
					reasoningText: 'let me think'
				})
			}
		});
		expect(screen.getByText('Reasoning')).toBeInTheDocument();
		expect(screen.getByText('let me think')).toBeInTheDocument();
	});
});
