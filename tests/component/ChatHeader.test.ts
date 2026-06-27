/* @vitest-environment happy-dom */

/**
 * Component test for ChatHeader — pure conversation identity (title + model).
 * The context-budget readout and Compact action live in ContextBudgetBar now
 * (tested there).
 */

import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/svelte';
import ChatHeader from '$lib/components/chat/ChatHeader.svelte';

describe('ChatHeader', () => {
	it('renders the conversation title', () => {
		render(ChatHeader, { props: { title: 'My chat', assistantLabel: 'gpt-4o' } });
		expect(screen.getByRole('heading', { name: 'My chat' })).toBeInTheDocument();
	});

	it('falls back to "Untitled chat" when title is null', () => {
		render(ChatHeader, { props: { title: null, assistantLabel: 'gpt-4o' } });
		expect(screen.getByRole('heading', { name: 'Untitled chat' })).toBeInTheDocument();
	});

	it('renders the assistant label', () => {
		render(ChatHeader, { props: { title: 'x', assistantLabel: 'Claude Opus' } });
		expect(screen.getByText('Claude Opus')).toBeInTheDocument();
	});

	it('no longer carries the token readout or Compact button', () => {
		render(ChatHeader, { props: { title: 'x', assistantLabel: 'gpt-4o' } });
		expect(screen.queryByText(/tokens/)).toBeNull();
		expect(screen.queryByRole('button', { name: /compact/i })).toBeNull();
	});
});
