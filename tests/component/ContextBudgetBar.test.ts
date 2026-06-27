/* @vitest-environment happy-dom */

/**
 * Component test for ContextBudgetBar — the context readout + Compact action
 * shown above the composer.
 */

import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import ContextBudgetBar from '$lib/components/chat/ContextBudgetBar.svelte';

const noop = () => {};

describe('ContextBudgetBar — readout', () => {
	it('hides the token count when zero', () => {
		render(ContextBudgetBar, { props: { contextTokenCount: 0, onCompact: noop } });
		expect(screen.queryByText(/tokens/)).toBeNull();
	});

	it('shows "N / max tokens · P%" when the window is known', () => {
		render(ContextBudgetBar, {
			props: { contextTokenCount: 27725, contextWindow: 40960, onCompact: noop },
		});
		expect(screen.getByText(/27,725 \/ 40,960 tokens · 68%/)).toBeInTheDocument();
	});

	it('falls back to a bare count when the window is unknown', () => {
		render(ContextBudgetBar, {
			props: { contextTokenCount: 27725, contextWindow: null, onCompact: noop },
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
			props: { contextTokenCount: 100, canCompact: true, onCompact },
		});
		const btn = screen.getByRole('button', { name: /compact/i });
		expect(btn).not.toBeDisabled();
		await user.click(btn);
		expect(onCompact).toHaveBeenCalledOnce();
	});

	it('disables Compact when canCompact is false', () => {
		render(ContextBudgetBar, {
			props: { contextTokenCount: 100, canCompact: false, onCompact: noop },
		});
		expect(screen.getByRole('button', { name: /compact/i })).toBeDisabled();
	});

	it('shows a "Compacting…" state and stays disabled while compacting', () => {
		render(ContextBudgetBar, {
			props: { contextTokenCount: 100, canCompact: true, compacting: true, onCompact: noop },
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
			props: { contextTokenCount: 100, canCompact: true, onCompact: noop },
		});
		// happy-dom doesn't apply the `hidden sm:inline` CSS, so the span is in
		// the DOM — we're asserting the label exists to be shown at sm+.
		const btn = screen.getByRole('button', { name: /compact/i });
		expect(btn.textContent).toMatch(/Compact/);
	});
});
