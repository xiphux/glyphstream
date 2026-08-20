/* @vitest-environment happy-dom */

/**
 * Component test for ChatHeader — the conversation title, the Private badge,
 * and the avatar action. The model name moved to the assistant bubbles +
 * composer picker; the context-budget readout and Compact action live in
 * ContextBudgetBar (tested there).
 */

import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/svelte';
import ChatHeader from '$lib/components/chat/ChatHeader.svelte';

describe('ChatHeader', () => {
	it('renders the conversation title', () => {
		render(ChatHeader, { props: { title: 'My chat' } });
		expect(screen.getByRole('heading', { name: 'My chat' })).toBeInTheDocument();
	});

	it('falls back to "Untitled chat" when title is null', () => {
		render(ChatHeader, { props: { title: null } });
		expect(screen.getByRole('heading', { name: 'Untitled chat' })).toBeInTheDocument();
	});

	it('carries nothing but the title — no model name, token readout, or Compact button', () => {
		render(ChatHeader, { props: { title: 'My chat' } });
		expect(screen.queryByText(/tokens/)).toBeNull();
		expect(screen.queryByRole('button', { name: /compact/i })).toBeNull();
		// Exactly one heading, no secondary model row.
		expect(screen.getAllByRole('heading')).toHaveLength(1);
	});

	it('shows the Private badge only when the chat is private', () => {
		render(ChatHeader, { props: { title: 'My chat', private: true } });
		expect(screen.getByText('Private')).toBeInTheDocument();
	});

	it('omits the Private badge for a normal chat (default)', () => {
		render(ChatHeader, { props: { title: 'My chat' } });
		expect(screen.queryByText('Private')).toBeNull();
	});
});

/**
 * The avatar action's presence rule. It's driven by the callback being
 * supplied rather than a flag this component interprets, so "hidden where it
 * can't work" stays the page's decision and this only has to honour it.
 */
describe('ChatHeader — avatar action', () => {
	const avatarButton = () => screen.queryByRole('button', { name: 'Avatar for this conversation' });

	const avatarProps = {
		models: [],
		modelId: '',
		avatarMediaId: null,
		hasSource: false,
		alreadyDrawn: false,
		status: null,
		busy: false,
		onDescribe: vi.fn(),
		onGenerate: vi.fn(),
		onModelChange: vi.fn(),
	};

	it('offers the avatar menu when the page supplies its state', () => {
		render(ChatHeader, { props: { title: 'With Ilya', avatar: avatarProps } });
		expect(avatarButton()).toBeInTheDocument();
	});

	it('hides the menu when the page omits it', () => {
		// How an image / video conversation opts out — there's no model there
		// that can answer a description request in prose.
		render(ChatHeader, { props: { title: 'Poster drafts' } });
		expect(avatarButton()).not.toBeInTheDocument();
	});
});
