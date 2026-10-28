/**
 * The 'texting' reply style through the bubbles that render it: a stored reply
 * (MessageBubble) and a live one (InFlightBubble) split into one bubble per
 * text, with a sender header only where the sender changes. The splitting rules
 * themselves are covered in tests/unit/texting.test.ts.
 */

import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/svelte';
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

	it('gives the preset an initial when it has no avatar, as any speaker has', () => {
		render(MessageBubble, { props: { ...bubbleProps, message: reply(GROUP) } });
		// Chloe opens and closes the run; Sam's run has one.
		expect(screen.getAllByText('C')).toHaveLength(2);
		expect(screen.getAllByText('S')).toHaveLength(1);
	});

	it('shows the avatar instead, where the preset has one', () => {
		render(MessageBubble, {
			props: { ...bubbleProps, assistantAvatarMediaId: 'face', message: reply(GROUP) },
		});
		expect(screen.queryByText('C')).toBeNull();
		expect(screen.getAllByText('S')).toHaveLength(1);
	});

	it('leaves the standard bubble alone when the style is off', () => {
		render(MessageBubble, {
			props: { ...bubbleProps, texting: false, message: reply(GROUP) },
		});
		expect(screen.getByText('Sam: yo')).toBeInTheDocument();
		expect(screen.getAllByText('Chloe')).toHaveLength(1);
	});

	// A tool turn's next row starts over with the assistant; without its header,
	// that text would read as from whoever spoke last in the row above.
	it('keeps the opening header on a reply that continues the one above', () => {
		render(MessageBubble, {
			props: { ...bubbleProps, mergeWithPrev: true, message: reply('<p>more</p>') },
		});
		expect(screen.getByText('more')).toBeInTheDocument();
		expect(screen.getByText('Chloe')).toBeInTheDocument();
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
			props: { ...live, blocks: [{ type: 'plain-text', text: 'hey\n\nSam: yo\n\nwhat' }] },
		});
		expect(screen.getByText('hey')).toBeInTheDocument();
		expect(screen.getByText('yo')).toBeInTheDocument();
		expect(screen.getByText('Sam')).toBeInTheDocument();
		// The text still being written is someone typing, not half a text.
		expect(screen.queryByText('what')).toBeNull();
		expect(screen.getByRole('status', { name: 'Sam is typing' })).toBeInTheDocument();
	});

	it('shows the last text whole once the reply has finished', () => {
		render(InFlightBubble, {
			props: {
				assistantLabel: 'Chloe',
				label: 'Thinking',
				status: null,
				progress: null,
				elapsedSeconds: 0,
				onImageClick: vi.fn(),
				texting: true,
				typing: false,
				blocks: [{ type: 'plain-text', text: 'hey\n\nwhat' }],
			},
		});
		expect(screen.getByText('what')).toBeInTheDocument();
		expect(screen.queryByRole('status')).toBeNull();
	});

	it('types a half-written marker too, rather than showing it as text', () => {
		render(InFlightBubble, {
			props: {
				assistantLabel: 'Chloe',
				label: 'Thinking',
				status: null,
				progress: null,
				elapsedSeconds: 0,
				onImageClick: vi.fn(),
				texting: true,
				blocks: [{ type: 'plain-text', text: 'one sec\n\n[photo: me at th' }],
			},
		});
		expect(screen.getByText('one sec')).toBeInTheDocument();
		expect(screen.queryByText(/\[photo/)).toBeNull();
		expect(screen.getByRole('status', { name: 'Chloe is typing' })).toBeInTheDocument();
	});

	it('stops typing once a check-in marker is finished, keeping its sender', () => {
		render(InFlightBubble, {
			props: {
				assistantLabel: 'Chloe',
				label: 'Thinking',
				status: null,
				progress: null,
				elapsedSeconds: 0,
				onImageClick: vi.fn(),
				texting: true,
				blocks: [{ type: 'plain-text', text: 'hey\n\nSam: yo\n\n[later 1h: ask about work]' }],
			},
		});
		expect(screen.getByText('yo')).toBeInTheDocument();
		expect(screen.queryByRole('status')).toBeNull();
		// Only the opening header: nothing claims the marker for Chloe.
		expect(screen.getAllByText('Chloe')).toHaveLength(1);
	});

	it('types nothing in a stored reply', () => {
		render(MessageBubble, { props: { ...bubbleProps, message: reply(GROUP) } });
		expect(screen.queryByRole('status')).toBeNull();
		expect(screen.getByText('nm')).toBeInTheDocument();
	});

	describe('photos', () => {
		const PHOTOS = '<p>look</p>\n<p>[photo: me at the beach]</p>\n<p>Sam: [photo: the dog]</p>';

		it('shows an undeveloped marker as a photo to develop', async () => {
			const onDevelop = vi.fn();
			render(MessageBubble, {
				props: {
					...bubbleProps,
					message: reply(PHOTOS),
					textingPhotos: { developed: new Set([1]), onDevelop },
				},
			});
			expect(screen.getByText('me at the beach')).toBeInTheDocument();
			// The developed one has arrived as a photo below, so it isn't shown here.
			expect(screen.queryByText('the dog')).toBeNull();
			await fireEvent.click(screen.getByRole('button', { name: 'Develop' }));
			expect(onDevelop).toHaveBeenCalledWith(0);
		});

		it('offers no Develop where nothing can develop it', () => {
			render(MessageBubble, {
				props: {
					...bubbleProps,
					message: reply(PHOTOS),
					textingPhotos: { developed: new Set<number>() },
				},
			});
			expect(screen.getByText('the dog')).toBeInTheDocument();
			expect(screen.queryByRole('button', { name: 'Develop' })).toBeNull();
		});

		it('draws a developed photo bare, under its sender, with a way to develop it again', async () => {
			const onRedevelop = vi.fn();
			const onImageClick = vi.fn();
			render(MessageBubble, {
				props: {
					...bubbleProps,
					onImageClick,
					mergeWithPrev: true,
					message: {
						...reply(''),
						contentHtml: null,
						parts: [
							{
								type: 'image',
								mediaId: 'media-1',
								aspectRatio: '3:4',
								photo: { sourceMessageId: 'm-0', index: 1, speaker: 'Sam' },
							},
						],
					},
					textingPhotos: { developed: new Set<number>(), onRedevelop },
				},
			});
			expect(screen.getByText('Sam')).toBeInTheDocument();
			await fireEvent.click(screen.getByRole('button', { name: 'Open photo' }));
			expect(onImageClick).toHaveBeenCalledWith('media-1');
			await fireEvent.click(screen.getByRole('button', { name: 'Develop again' }));
			expect(onRedevelop).toHaveBeenCalled();
		});
	});
});

describe('texting check-ins', () => {
	const MARKED = '<p>gtg</p>\n<p>[later 1h: ask about work]</p>';

	it('never shows the marker as a text', () => {
		render(MessageBubble, { props: { ...bubbleProps, message: reply(MARKED) } });
		expect(screen.getByText('gtg')).toBeInTheDocument();
		expect(screen.queryByText(/later 1h/)).toBeNull();
		expect(screen.queryByText(/check in/)).toBeNull();
	});

	it('says when a pending one is due, and offers to call it off', async () => {
		const onCancel = vi.fn();
		render(MessageBubble, {
			props: {
				...bubbleProps,
				message: reply(MARKED),
				checkIn: { fireAt: Date.now() + 3_600_000, onCancel },
			},
		});
		expect(screen.getByText(/Will check in around/)).toBeInTheDocument();
		// What it meant to say stays a surprise.
		expect(screen.queryByText(/ask about work/)).toBeNull();
		await fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
		expect(onCancel).toHaveBeenCalledOnce();
	});
	it('works the same way under a standard reply', () => {
		render(MessageBubble, {
			props: {
				...bubbleProps,
				texting: false,
				message: reply(MARKED),
				checkIn: { fireAt: Date.now() + 3_600_000, onCancel: vi.fn() },
			},
		});
		expect(screen.getByText('gtg')).toBeInTheDocument();
		expect(screen.queryByText(/later 1h/)).toBeNull();
		expect(screen.getByText(/Will check in around/)).toBeInTheDocument();
	});
});
