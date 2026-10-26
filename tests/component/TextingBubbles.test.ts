/**
 * The 'texting' reply style through the bubbles that render it: a stored reply
 * (MessageBubble) and a live one (InFlightBubble) split into one bubble per
 * text, with a sender header only where the sender changes. The splitting rules
 * themselves are covered in tests/unit/texting.test.ts.
 */

import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/svelte';
import MessageBubble from '#lib/components/chat/MessageBubble.svelte';
import InFlightBubble from '#lib/components/chat/InFlightBubble.svelte';
import type { ChatMessage } from '#lib/types/api.js';

function reply(contentHtml: string): ChatMessage {
	return {
		id: 'm-1',
		role: 'assistant',
		parts: [{ type: 'text', text: 'unused: the html is what renders' }],
		contentHtml,
		reasoningText: null,
		finishReason: null,
		modelUsed: null,
		tokensIn: null,
		tokensOut: null,
		genMs: null,
		createdAt: 0,
	};
}

const bubbleProps = {
	toolResultsByCallId: new Map(),
	userLabel: 'Chris',
	assistantLabel: 'Chloe',
	mergeWithPrev: false,
	mergeWithNext: false,
	onImageClick: vi.fn(),
	texting: true,
};

const GROUP = '<p>hey</p>\n<p>Sam: yo</p>\n<p>whats up</p>\n<p>Chloe: nm</p>';

describe('texting reply style', () => {
	it('renders one bubble per text, with a header where the sender changes', () => {
		render(MessageBubble, { props: { ...bubbleProps, message: reply(GROUP) } });
		for (const text of ['hey', 'yo', 'whats up', 'nm']) {
			expect(screen.getByText(text)).toBeInTheDocument();
		}
		// Chloe opens and closes the run; Sam's two texts share one header.
		expect(screen.getAllByText('Chloe')).toHaveLength(2);
		expect(screen.getAllByText('Sam')).toHaveLength(1);
		// The prefix is the header, not part of the text.
		expect(screen.queryByText(/Sam: yo/)).toBeNull();
	});

	it('leaves the standard bubble alone when the style is off', () => {
		render(MessageBubble, {
			props: { ...bubbleProps, texting: false, message: reply(GROUP) },
		});
		expect(screen.getByText('Sam: yo')).toBeInTheDocument();
		expect(screen.getAllByText('Chloe')).toHaveLength(1);
	});

	it('drops the opening header on a reply that continues the one above', () => {
		render(MessageBubble, {
			props: { ...bubbleProps, mergeWithPrev: true, message: reply('<p>more</p>') },
		});
		expect(screen.getByText('more')).toBeInTheDocument();
		expect(screen.queryByText('Chloe')).toBeNull();
	});

	it('draws no empty bubble for a reply that only edited a canvas', () => {
		const { container } = render(InFlightBubble, {
			props: {
				assistantLabel: 'Chloe',
				label: 'Thinking',
				status: null,
				progress: null,
				elapsedSeconds: 0,
				onImageClick: vi.fn(),
				texting: true,
				blocks: [
					{
						type: 'tool_call',
						toolCallId: 't1',
						toolName: 'create_canvas',
						arguments: '{}',
						status: 'executing',
					},
				],
			},
		});
		expect(container.querySelector('.rounded-2xl')).toBeNull();
	});

	it('splits a live reply the same way, and types before the first token', () => {
		const live = {
			assistantLabel: 'Chloe',
			label: 'Thinking',
			status: null,
			progress: null,
			elapsedSeconds: 0,
			onImageClick: vi.fn(),
			texting: true,
		};
		const { unmount } = render(InFlightBubble, { props: { ...live, blocks: [] } });
		expect(screen.getByText('Thinking')).toBeInTheDocument();
		expect(screen.getByText('Chloe')).toBeInTheDocument();
		unmount();

		render(InFlightBubble, {
			props: { ...live, blocks: [{ type: 'plain-text', text: 'hey\n\nSam: yo' }] },
		});
		expect(screen.getByText('hey')).toBeInTheDocument();
		expect(screen.getByText('yo')).toBeInTheDocument();
		expect(screen.getByText('Sam')).toBeInTheDocument();
	});
});
