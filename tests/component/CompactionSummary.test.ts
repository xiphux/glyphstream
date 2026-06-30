/* @vitest-environment happy-dom */

/**
 * Component test for CompactionSummary — the collapsed, expandable divider
 * that stands in for summarized history.
 */

import { describe, expect, it, vi } from 'vitest';
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

	it('shows the Undo control only when canUndo, and only once expanded', async () => {
		const user = userEvent.setup();
		const onUndo = vi.fn();
		render(CompactionSummary, { props: { message: summaryMessage(), canUndo: true, onUndo } });

		// Hidden while collapsed (it lives in the expanded body).
		expect(screen.queryByRole('button', { name: /undo compaction/i })).toBeNull();

		await user.click(screen.getByRole('button', { name: /Context summary/ }));
		const undo = screen.getByRole('button', { name: /undo compaction/i });
		await user.click(undo);
		expect(onUndo).toHaveBeenCalledOnce();
	});

	it('omits the Undo control when canUndo is false', async () => {
		const user = userEvent.setup();
		render(CompactionSummary, { props: { message: summaryMessage(), canUndo: false } });
		await user.click(screen.getByRole('button', { name: /Context summary/ }));
		expect(screen.queryByRole('button', { name: /undo compaction/i })).toBeNull();
	});
});
