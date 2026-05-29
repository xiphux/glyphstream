/* @vitest-environment happy-dom */

/**
 * Component test for Toaster — the singleton "one toast at a time"
 * surface that reads from the `toast` store.
 *
 * Each kind (success / info / error) maps to a different lucide icon
 * + color class. The auto-dismiss timer is part of the store, not the
 * component, but worth exercising end-to-end via fake timers.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { tick } from 'svelte';
import { render, screen } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import Toaster from '$lib/components/Toaster.svelte';
import { toast } from '$lib/toast.svelte';

afterEach(() => {
	toast.dismiss();
	vi.useRealTimers();
});

describe('Toaster — rendering', () => {
	it('renders nothing when no toast is active', () => {
		render(Toaster);
		expect(screen.queryByRole('status')).toBeNull();
	});

	it('renders the message text when a success toast is shown', async () => {
		render(Toaster);
		toast.success('Saved successfully');
		await tick();
		const status = screen.getByRole('status');
		expect(status).toHaveTextContent('Saved successfully');
	});

	it('uses aria-live=polite on the toast surface', async () => {
		render(Toaster);
		toast.info('Heads up');
		await tick();
		expect(screen.getByRole('status')).toHaveAttribute('aria-live', 'polite');
	});

	it('renders an emerald success icon for success kind', async () => {
		const { container } = render(Toaster);
		toast.success('ok');
		await tick();
		expect(container.querySelector('.text-emerald-600, .text-emerald-400')).toBeInTheDocument();
	});

	it('renders a red error icon for error kind', async () => {
		const { container } = render(Toaster);
		toast.error('something broke');
		await tick();
		expect(container.querySelector('.text-red-600, .text-red-400')).toBeInTheDocument();
	});

	it('renders a neutral info icon for info kind', async () => {
		const { container } = render(Toaster);
		toast.info('fyi');
		await tick();
		expect(container.querySelector('.text-fg-muted')).toBeInTheDocument();
	});

	it('always renders a Dismiss button', async () => {
		render(Toaster);
		toast.info('hi');
		await tick();
		expect(screen.getByRole('button', { name: 'Dismiss' })).toBeInTheDocument();
	});
});

describe('Toaster — action button', () => {
	it('renders the action label when an action is supplied', async () => {
		render(Toaster);
		toast.info('Archived', { action: { label: 'Undo', handler: vi.fn() } });
		await tick();
		expect(screen.getByRole('button', { name: 'Undo' })).toBeInTheDocument();
	});

	it('does NOT render an action button when no action is supplied', async () => {
		render(Toaster);
		toast.info('just info');
		await tick();
		// The only buttons should be Dismiss.
		const buttons = screen.getAllByRole('button');
		expect(buttons.map((b) => b.getAttribute('aria-label'))).toEqual(['Dismiss']);
	});

	it('calls the action handler when the action button is clicked', async () => {
		const user = userEvent.setup();
		const handler = vi.fn();
		render(Toaster);
		toast.info('Archived', { action: { label: 'Undo', handler } });
		await tick();
		await user.click(screen.getByRole('button', { name: 'Undo' }));
		expect(handler).toHaveBeenCalledTimes(1);
	});

	it('dismisses the toast after the action handler completes', async () => {
		const user = userEvent.setup();
		const handler = vi.fn();
		render(Toaster);
		toast.info('Archived', { action: { label: 'Undo', handler } });
		await tick();
		await user.click(screen.getByRole('button', { name: 'Undo' }));
		await tick();
		expect(screen.queryByRole('status')).toBeNull();
	});
});

describe('Toaster — dismiss + replacement', () => {
	it('removes the toast when Dismiss is clicked', async () => {
		const user = userEvent.setup();
		render(Toaster);
		toast.info('temporary');
		await tick();
		await user.click(screen.getByRole('button', { name: 'Dismiss' }));
		await tick();
		expect(screen.queryByRole('status')).toBeNull();
	});

	it('replaces the previous toast in place (no stacking)', async () => {
		render(Toaster);
		toast.info('first');
		await tick();
		expect(screen.getByRole('status')).toHaveTextContent('first');

		toast.success('second');
		await tick();
		// Only ONE toast surface at any time.
		expect(screen.getAllByRole('status')).toHaveLength(1);
		expect(screen.getByRole('status')).toHaveTextContent('second');
	});
});

describe('Toaster — auto-dismiss', () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	it('auto-dismisses after the default duration for success (4000 ms)', async () => {
		render(Toaster);
		toast.success('flash');
		await tick();
		expect(screen.getByRole('status')).toBeInTheDocument();

		vi.advanceTimersByTime(3999);
		await tick();
		expect(screen.getByRole('status')).toBeInTheDocument();

		vi.advanceTimersByTime(1);
		await tick();
		expect(screen.queryByRole('status')).toBeNull();
	});

	it('honors a custom duration override', async () => {
		render(Toaster);
		toast.info('quick', { duration: 100 });
		await tick();
		expect(screen.getByRole('status')).toBeInTheDocument();

		vi.advanceTimersByTime(100);
		await tick();
		expect(screen.queryByRole('status')).toBeNull();
	});

	it('does NOT auto-dismiss when duration is 0', async () => {
		render(Toaster);
		toast.info('sticky', { duration: 0 });
		await tick();

		vi.advanceTimersByTime(10_000);
		await tick();
		expect(screen.getByRole('status')).toBeInTheDocument();
	});
});
