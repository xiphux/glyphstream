/* @vitest-environment happy-dom */

/**
 * Component test for CompactionSummary — the collapsed, expandable divider
 * that stands in for summarized history.
 */

import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import CompactionSummary from '$lib/components/chat/CompactionSummary.svelte';
import type { ChatMessage } from '$lib/types/api';

function summaryMessage(overrides: Partial<ChatMessage> = {}): ChatMessage {
	return {
		id: 'S',
		role: 'assistant',
		parts: [{ type: 'text', text: 'The user asked about widgets; we decided to use foo.' }],
		contentHtml: null,
		reasoningText: null,
		finishReason: null,
		modelUsed: null,
		tokensIn: null,
		tokensOut: null,
		genMs: null,
		createdAt: 1,
		compactionResumeFromMessageId: 'u2',
		...overrides,
	};
}

describe('CompactionSummary', () => {
	it('renders the collapsed label and hides the body by default', () => {
		render(CompactionSummary, { props: { message: summaryMessage() } });
		expect(screen.getByText('Context summary')).toBeInTheDocument();
		expect(screen.queryByText(/decided to use foo/)).toBeNull();
	});

	it('expands to reveal the summary text on click', async () => {
		const user = userEvent.setup();
		render(CompactionSummary, { props: { message: summaryMessage() } });
		await user.click(screen.getByRole('button'));
		expect(screen.getByText(/decided to use foo/)).toBeInTheDocument();
	});

	it('renders server HTML when present', async () => {
		const user = userEvent.setup();
		render(CompactionSummary, {
			props: {
				message: summaryMessage({ contentHtml: '<p>rendered <strong>brief</strong></p>' }),
			},
		});
		await user.click(screen.getByRole('button'));
		expect(screen.getByText('brief')).toBeInTheDocument();
	});
});
