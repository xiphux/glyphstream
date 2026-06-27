/* @vitest-environment happy-dom */

/**
 * Component test for CompactionSummaryStreaming — the in-flight summary block
 * shown while a manual compaction streams.
 */

import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/svelte';
import CompactionSummaryStreaming from '$lib/components/chat/CompactionSummaryStreaming.svelte';

describe('CompactionSummaryStreaming', () => {
	it('shows the summarizing header', () => {
		render(CompactionSummaryStreaming, { props: { text: '' } });
		expect(screen.getByText('Summarizing context…')).toBeInTheDocument();
	});

	it('renders the streaming text as it accumulates', () => {
		render(CompactionSummaryStreaming, { props: { text: 'We decided to use foo' } });
		expect(screen.getByText(/decided to use foo/)).toBeInTheDocument();
	});

	it('omits the body region when no text has streamed yet', () => {
		render(CompactionSummaryStreaming, { props: { text: '' } });
		expect(screen.queryByText(/decided/)).toBeNull();
	});
});
