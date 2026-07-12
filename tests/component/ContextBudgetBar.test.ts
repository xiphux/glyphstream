/* @vitest-environment happy-dom */

/**
 * Component test for ContextBudgetBar — the context readout + Compact action
 * shown above the composer.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import ContextBudgetBar from '$lib/components/chat/ContextBudgetBar.svelte';
import type { ContextBreakdown } from '$lib/types/api';

const noop = () => {};

/** The two props that only back the breakdown popover; every readout/Compact
 *  assertion below is indifferent to them. */
const panelProps = { conversationId: 'c1', revision: 0 };

describe('ContextBudgetBar — readout', () => {
	it('hides the token count when zero', () => {
		render(ContextBudgetBar, {
			props: { ...panelProps, contextTokenCount: 0, onCompact: noop },
		});
		expect(screen.queryByText(/tokens/)).toBeNull();
	});

	it('shows "N / max tokens · P%" when the window is known', () => {
		render(ContextBudgetBar, {
			props: { ...panelProps, contextTokenCount: 27725, contextWindow: 40960, onCompact: noop },
		});
		expect(screen.getByText(/27,725 \/ 40,960 tokens · 68%/)).toBeInTheDocument();
	});

	it('falls back to a bare count when the window is unknown', () => {
		render(ContextBudgetBar, {
			props: { ...panelProps, contextTokenCount: 27725, contextWindow: null, onCompact: noop },
		});
		expect(screen.getByText(/27,725 tokens/)).toBeInTheDocument();
		expect(screen.queryByText(/\//)).toBeNull();
	});
});

describe('ContextBudgetBar — Compact action', () => {
	it('enables Compact when canCompact is true and fires onCompact', async () => {
		const onCompact = vi.fn();
		const user = userEvent.setup();
		render(ContextBudgetBar, {
			props: { ...panelProps, contextTokenCount: 100, canCompact: true, onCompact },
		});
		const btn = screen.getByRole('button', { name: /compact/i });
		expect(btn).not.toBeDisabled();
		await user.click(btn);
		expect(onCompact).toHaveBeenCalledOnce();
	});

	it('disables Compact when canCompact is false', () => {
		render(ContextBudgetBar, {
			props: { ...panelProps, contextTokenCount: 100, canCompact: false, onCompact: noop },
		});
		expect(screen.getByRole('button', { name: /compact/i })).toBeDisabled();
	});

	it('shows a "Compacting…" state and stays disabled while compacting', () => {
		render(ContextBudgetBar, {
			props: {
				...panelProps,
				contextTokenCount: 100,
				canCompact: true,
				compacting: true,
				onCompact: noop,
			},
		});
		const btn = screen.getByRole('button', { name: /compacting/i });
		expect(btn).toBeDisabled();
		// The tooltip must reflect the in-progress state, NOT the disabled-because-
		// nothing-to-compact copy (the button is disabled via `compacting`, but
		// canCompact may still be true).
		expect(btn.getAttribute('title')).toMatch(/in progress/i);
		expect(btn.getAttribute('title')).not.toMatch(/not enough/i);
	});

	it('carries a visible text label (the sm+ affordance, not just a tooltip)', () => {
		render(ContextBudgetBar, {
			props: { ...panelProps, contextTokenCount: 100, canCompact: true, onCompact: noop },
		});
		// happy-dom doesn't apply the `hidden sm:inline` CSS, so the span is in
		// the DOM — we're asserting the label exists to be shown at sm+.
		const btn = screen.getByRole('button', { name: /compact/i });
		expect(btn.textContent).toMatch(/Compact/);
	});
});

describe('ContextBudgetBar — breakdown popover', () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	const breakdown: ContextBreakdown = {
		segments: [
			{
				key: 'tools:defs',
				chars: 9600,
				tokens: 2400,
				items: [{ label: 'run_python', chars: 2226 }],
			},
			{ key: 'persona:memories', chars: 4000, tokens: 1000 },
			{ key: 'history:text', chars: 2000, tokens: 500 },
		],
		estimatedTokens: 3900,
		reportedPromptTokens: 4210,
		imageBytes: 0,
		contextWindow: 40960,
	};

	function stubFetch(body: ContextBreakdown) {
		const fetchMock = vi.fn(async () => new Response(JSON.stringify(body), { status: 200 }));
		vi.stubGlobal('fetch', fetchMock);
		return fetchMock;
	}

	it('does not measure the context until the readout is opened', () => {
		const fetchMock = stubFetch(breakdown);
		render(ContextBudgetBar, {
			props: { ...panelProps, contextTokenCount: 4210, onCompact: noop },
		});
		// The endpoint re-runs the whole request assembly — it must not fire on
		// every render of every chat, only when someone actually asks.
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it('itemizes the context, splitting per-turn overhead from compactable history', async () => {
		const fetchMock = stubFetch(breakdown);
		const user = userEvent.setup();
		render(ContextBudgetBar, {
			props: { ...panelProps, contextTokenCount: 4210, onCompact: noop },
		});

		await user.click(screen.getByRole('button', { name: /4,210 tokens/ }));
		expect(fetchMock).toHaveBeenCalledWith('/api/conversations/c1/context');

		// Popover content is portaled to document.body — query via `screen`.
		expect(await screen.findByText('Tool definitions')).toBeInTheDocument();
		expect(screen.getByText('Saved memories')).toBeInTheDocument();
		expect(screen.getByText('Messages')).toBeInTheDocument();

		// The headline distinction: overhead survives compaction, history doesn't.
		expect(screen.getByText('Sent every turn')).toBeInTheDocument();
		expect(screen.getByText(/Compaction cannot shrink these/)).toBeInTheDocument();
		expect(screen.getByText('Conversation history')).toBeInTheDocument();

		// Overhead subtotal = 2400 + 1000, i.e. the two non-history segments.
		expect(screen.getByText('3,400 tok')).toBeInTheDocument();
		expect(screen.getByText('500 tok')).toBeInTheDocument();
	});

	it('shows the upstream-reported count alongside the estimate', async () => {
		stubFetch(breakdown);
		const user = userEvent.setup();
		render(ContextBudgetBar, {
			props: { ...panelProps, contextTokenCount: 4210, onCompact: noop },
		});
		await user.click(screen.getByRole('button', { name: /4,210 tokens/ }));
		// Both numbers, so a wide gap between them is visible rather than hidden
		// behind a single confident-looking figure.
		expect(await screen.findByText('4,210')).toBeInTheDocument();
		expect(screen.getByText('3,900')).toBeInTheDocument();
	});
});
