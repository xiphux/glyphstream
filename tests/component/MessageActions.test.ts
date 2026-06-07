/* @vitest-environment happy-dom */

/**
 * Component test for MessageActions — the per-message action toolbar.
 * Covers per-role button visibility, disabled-while-generating gating,
 * sibling-nav math, copy-confirmation state, and the token popover.
 */

import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import MessageActions from '$lib/components/chat/MessageActions.svelte';
import type { ChatMessage, MessageRole } from '$lib/types/api';

function makeMessage(role: MessageRole, overrides: Partial<ChatMessage> = {}): ChatMessage {
	return {
		id: overrides.id ?? 'm-1',
		role,
		parts: overrides.parts ?? [{ type: 'text', text: 'hi' }],
		contentHtml: null,
		reasoningText: null,
		finishReason: null,
		modelUsed: null,
		tokensIn: null,
		tokensOut: overrides.tokensOut ?? null,
		genMs: overrides.genMs ?? null,
		createdAt: 0,
		...overrides,
	};
}

const cb = () => ({
	onCopy: vi.fn(),
	onEdit: vi.fn(),
	onRetry: vi.fn(),
	onSelectSibling: vi.fn(),
	onDeleteBranch: vi.fn(),
});

const baseProps = {
	generating: false,
	recentlyCopied: false,
	canCopy: true,
	userSentTokens: null as number | null,
};

describe('MessageActions — per-role buttons', () => {
	it('user messages show Edit but not Retry', () => {
		render(MessageActions, {
			props: { ...baseProps, ...cb(), message: makeMessage('user') },
		});
		expect(screen.getByRole('button', { name: 'Edit message' })).toBeInTheDocument();
		expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
	});

	it('assistant messages show Retry but not Edit', () => {
		render(MessageActions, {
			props: { ...baseProps, ...cb(), message: makeMessage('assistant') },
		});
		expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
		expect(screen.queryByRole('button', { name: 'Edit message' })).toBeNull();
	});

	it('shows Copy when canCopy is true', () => {
		render(MessageActions, {
			props: { ...baseProps, ...cb(), message: makeMessage('user') },
		});
		expect(screen.getByRole('button', { name: 'Copy message' })).toBeInTheDocument();
	});

	it('hides Copy when canCopy is false', () => {
		render(MessageActions, {
			props: { ...baseProps, ...cb(), canCopy: false, message: makeMessage('assistant') },
		});
		expect(screen.queryByRole('button', { name: 'Copy message' })).toBeNull();
	});

	it('shows the Copied label + checkmark state when recentlyCopied', () => {
		render(MessageActions, {
			props: { ...baseProps, ...cb(), recentlyCopied: true, message: makeMessage('user') },
		});
		expect(screen.getByRole('button', { name: 'Copied' })).toBeInTheDocument();
	});
});

describe('MessageActions — callbacks', () => {
	it('fires onCopy when Copy is clicked', async () => {
		const user = userEvent.setup();
		const cbs = cb();
		render(MessageActions, { props: { ...baseProps, ...cbs, message: makeMessage('user') } });
		await user.click(screen.getByRole('button', { name: 'Copy message' }));
		expect(cbs.onCopy).toHaveBeenCalledTimes(1);
	});

	it('fires onEdit when Edit is clicked', async () => {
		const user = userEvent.setup();
		const cbs = cb();
		render(MessageActions, { props: { ...baseProps, ...cbs, message: makeMessage('user') } });
		await user.click(screen.getByRole('button', { name: 'Edit message' }));
		expect(cbs.onEdit).toHaveBeenCalledTimes(1);
	});

	it('fires onRetry when Retry is clicked', async () => {
		const user = userEvent.setup();
		const cbs = cb();
		render(MessageActions, { props: { ...baseProps, ...cbs, message: makeMessage('assistant') } });
		await user.click(screen.getByRole('button', { name: 'Retry' }));
		expect(cbs.onRetry).toHaveBeenCalledTimes(1);
	});

	it('disables Edit/Retry while generating', () => {
		render(MessageActions, {
			props: { ...baseProps, ...cb(), generating: true, message: makeMessage('user') },
		});
		expect(screen.getByRole('button', { name: 'Edit message' })).toBeDisabled();
	});

	it('leaves Copy enabled even while generating', () => {
		render(MessageActions, {
			props: { ...baseProps, ...cb(), generating: true, message: makeMessage('user') },
		});
		expect(screen.getByRole('button', { name: 'Copy message' })).not.toBeDisabled();
	});
});

describe('MessageActions — sibling navigation', () => {
	const sibProps = (overrides: Partial<ChatMessage>) =>
		makeMessage('assistant', {
			id: 'b',
			siblingCount: 3,
			siblingPosition: 2,
			siblingIds: ['a', 'b', 'c'],
			...overrides,
		});

	it('renders the position counter when siblings exist', () => {
		render(MessageActions, { props: { ...baseProps, ...cb(), message: sibProps({}) } });
		expect(screen.getByText('2 / 3')).toBeInTheDocument();
	});

	it('does not render sibling nav for a lone message', () => {
		render(MessageActions, {
			props: { ...baseProps, ...cb(), message: makeMessage('assistant', { siblingCount: 1 }) },
		});
		expect(screen.queryByRole('button', { name: 'Previous sibling' })).toBeNull();
	});

	it('Previous selects the prior sibling id', async () => {
		const user = userEvent.setup();
		const cbs = cb();
		render(MessageActions, { props: { ...baseProps, ...cbs, message: sibProps({}) } });
		await user.click(screen.getByRole('button', { name: 'Previous sibling' }));
		// pos=2 → ids[pos-2] = ids[0] = 'a'; dir = -1 (previous)
		expect(cbs.onSelectSibling).toHaveBeenCalledWith('a', -1);
	});

	it('Next selects the following sibling id', async () => {
		const user = userEvent.setup();
		const cbs = cb();
		render(MessageActions, { props: { ...baseProps, ...cbs, message: sibProps({}) } });
		await user.click(screen.getByRole('button', { name: 'Next sibling' }));
		// pos=2 → ids[pos] = ids[2] = 'c'; dir = +1 (next)
		expect(cbs.onSelectSibling).toHaveBeenCalledWith('c', 1);
	});

	it('disables Previous at the first sibling', () => {
		render(MessageActions, {
			props: { ...baseProps, ...cb(), message: sibProps({ siblingPosition: 1 }) },
		});
		expect(screen.getByRole('button', { name: 'Previous sibling' })).toBeDisabled();
		expect(screen.getByRole('button', { name: 'Next sibling' })).not.toBeDisabled();
	});

	it('disables Next at the last sibling', () => {
		render(MessageActions, {
			props: { ...baseProps, ...cb(), message: sibProps({ siblingPosition: 3 }) },
		});
		expect(screen.getByRole('button', { name: 'Next sibling' })).toBeDisabled();
	});

	it('fires onDeleteBranch from the trash button', async () => {
		const user = userEvent.setup();
		const cbs = cb();
		render(MessageActions, { props: { ...baseProps, ...cbs, message: sibProps({}) } });
		await user.click(screen.getByRole('button', { name: 'Delete this branch' }));
		expect(cbs.onDeleteBranch).toHaveBeenCalledTimes(1);
	});
});

describe('MessageActions — token popover', () => {
	it('shows the token trigger for an assistant message with tokensOut', () => {
		render(MessageActions, {
			props: { ...baseProps, ...cb(), message: makeMessage('assistant', { tokensOut: 512 }) },
		});
		expect(
			screen.getByRole('button', { name: 'Token usage for this message' }),
		).toBeInTheDocument();
	});

	it('hides the token trigger when an assistant message has zero tokensOut', () => {
		render(MessageActions, {
			props: { ...baseProps, ...cb(), message: makeMessage('assistant', { tokensOut: 0 }) },
		});
		expect(screen.queryByRole('button', { name: 'Token usage for this message' })).toBeNull();
	});

	it('shows the token trigger for a user message with userSentTokens', () => {
		render(MessageActions, {
			props: { ...baseProps, ...cb(), userSentTokens: 1024, message: makeMessage('user') },
		});
		expect(
			screen.getByRole('button', { name: 'Token usage for this message' }),
		).toBeInTheDocument();
	});

	it('reveals "Generated" count on open for assistant messages', async () => {
		const user = userEvent.setup();
		render(MessageActions, {
			props: { ...baseProps, ...cb(), message: makeMessage('assistant', { tokensOut: 512 }) },
		});
		await user.click(screen.getByRole('button', { name: 'Token usage for this message' }));
		expect(screen.getByText('Generated')).toBeInTheDocument();
		expect(screen.getByText('512')).toBeInTheDocument();
	});

	it('reveals "Sent to model" count on open for user messages', async () => {
		const user = userEvent.setup();
		render(MessageActions, {
			props: { ...baseProps, ...cb(), userSentTokens: 1024, message: makeMessage('user') },
		});
		await user.click(screen.getByRole('button', { name: 'Token usage for this message' }));
		expect(screen.getByText('Sent to model')).toBeInTheDocument();
		expect(screen.getByText('1,024')).toBeInTheDocument();
	});

	it('shows a tok/s rate + duration when genMs is present', async () => {
		const user = userEvent.setup();
		render(MessageActions, {
			// 512 tokens over 4s ⇒ 128 tok/s.
			props: {
				...baseProps,
				...cb(),
				message: makeMessage('assistant', { tokensOut: 512, genMs: 4000 }),
			},
		});
		await user.click(screen.getByRole('button', { name: 'Token usage for this message' }));
		expect(screen.getByText('Speed')).toBeInTheDocument();
		expect(screen.getByText(/128 tok\/s · 4\.0s/)).toBeInTheDocument();
	});

	it('omits the Speed row when genMs is absent', async () => {
		const user = userEvent.setup();
		render(MessageActions, {
			props: { ...baseProps, ...cb(), message: makeMessage('assistant', { tokensOut: 512 }) },
		});
		await user.click(screen.getByRole('button', { name: 'Token usage for this message' }));
		expect(screen.queryByText('Speed')).toBeNull();
	});

	it('shows a raw generation time for an image message', async () => {
		const user = userEvent.setup();
		render(MessageActions, {
			props: {
				...baseProps,
				...cb(),
				message: makeMessage('assistant', {
					parts: [{ type: 'image', mediaId: 'img-1' }],
					genMs: 4200,
				}),
			},
		});
		await user.click(screen.getByRole('button', { name: 'Token usage for this message' }));
		expect(screen.getByText('Generated in')).toBeInTheDocument();
		expect(screen.getByText('4.2s')).toBeInTheDocument();
	});
});
