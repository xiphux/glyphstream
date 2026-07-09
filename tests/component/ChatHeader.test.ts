/* @vitest-environment happy-dom */

/**
 * Component test for ChatHeader — just the conversation title now. The model
 * name moved to the assistant bubbles + composer picker; the context-budget
 * readout and Compact action live in ContextBudgetBar (tested there).
 */

import { describe, expect, it } from 'vitest';
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
