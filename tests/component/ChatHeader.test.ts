/* @vitest-environment happy-dom */

/**
 * Component test for ChatHeader — read-only conversation header.
 */

import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/svelte';
import ChatHeader from '$lib/components/chat/ChatHeader.svelte';

describe('ChatHeader', () => {
	it('renders the conversation title', () => {
		render(ChatHeader, {
			props: { title: 'My chat', assistantLabel: 'gpt-4o', contextTokenCount: 0 }
		});
		expect(screen.getByRole('heading', { name: 'My chat' })).toBeInTheDocument();
	});

	it('falls back to "Untitled chat" when title is null', () => {
		render(ChatHeader, {
			props: { title: null, assistantLabel: 'gpt-4o', contextTokenCount: 0 }
		});
		expect(screen.getByRole('heading', { name: 'Untitled chat' })).toBeInTheDocument();
	});

	it('renders the assistant label', () => {
		render(ChatHeader, {
			props: { title: 'x', assistantLabel: 'Claude Opus', contextTokenCount: 0 }
		});
		expect(screen.getByText('Claude Opus')).toBeInTheDocument();
	});

	it('hides the token count when zero', () => {
		render(ChatHeader, {
			props: { title: 'x', assistantLabel: 'gpt-4o', contextTokenCount: 0 }
		});
		expect(screen.queryByText(/tokens/)).toBeNull();
	});

	it('shows the formatted token count when positive', () => {
		render(ChatHeader, {
			props: { title: 'x', assistantLabel: 'gpt-4o', contextTokenCount: 12345 }
		});
		// Intl.NumberFormat default locale groups thousands.
		expect(screen.getByText(/12,345 tokens/)).toBeInTheDocument();
	});
});
