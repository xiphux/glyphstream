/* @vitest-environment happy-dom */

/**
 * Component test for ConfirmDialog — the app-wide destructive-action
 * confirmation host.
 *
 * Contract is store-driven, not prop-driven: `confirmDialog.ask({...})`
 * returns a Promise<boolean> that resolves true on confirm, false on
 * cancel / Escape / backdrop click. The host reads `confirmDialog.pending`
 * and renders the modal when non-null.
 *
 * Singleton store — `afterEach` cancels any leftover pending dialog so
 * tests don't bleed into each other.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { tick } from 'svelte';
import { render, screen, fireEvent } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import ConfirmDialog from '$lib/components/ConfirmDialog.svelte';
import { confirmDialog } from '$lib/confirm.svelte';

afterEach(() => {
	if (confirmDialog.pending) confirmDialog.cancel();
});

describe('ConfirmDialog — rendering', () => {
	it('renders nothing when no dialog is pending', () => {
		render(ConfirmDialog);
		expect(screen.queryByRole('alertdialog')).toBeNull();
	});

	it('renders the title, message, and default buttons when a dialog is pending', async () => {
		render(ConfirmDialog);
		void confirmDialog.ask({
			title: 'Delete this branch?',
			message: 'This will remove three messages.'
		});
		await tick();
		expect(screen.getByRole('alertdialog')).toBeInTheDocument();
		expect(screen.getByText('Delete this branch?')).toBeInTheDocument();
		expect(screen.getByText('This will remove three messages.')).toBeInTheDocument();
		expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
		expect(screen.getByRole('button', { name: 'Delete' })).toBeInTheDocument();
	});

	it('honors a custom confirmLabel', async () => {
		render(ConfirmDialog);
		void confirmDialog.ask({
			title: 'Discard draft?',
			message: 'Your changes will be lost.',
			confirmLabel: 'Discard'
		});
		await tick();
		expect(screen.getByRole('button', { name: 'Discard' })).toBeInTheDocument();
		expect(screen.queryByRole('button', { name: 'Delete' })).toBeNull();
	});

	it('marks the dialog role=alertdialog with aria-modal=true', async () => {
		render(ConfirmDialog);
		void confirmDialog.ask({ title: 't', message: 'm' });
		await tick();
		const dialog = screen.getByRole('alertdialog');
		expect(dialog).toHaveAttribute('aria-modal', 'true');
	});
});

describe('ConfirmDialog — resolution', () => {
	it('resolves true when Delete is clicked', async () => {
		const user = userEvent.setup();
		render(ConfirmDialog);
		const promise = confirmDialog.ask({ title: 't', message: 'm' });
		await tick();
		await user.click(screen.getByRole('button', { name: 'Delete' }));
		await expect(promise).resolves.toBe(true);
	});

	it('resolves false when Cancel is clicked', async () => {
		const user = userEvent.setup();
		render(ConfirmDialog);
		const promise = confirmDialog.ask({ title: 't', message: 'm' });
		await tick();
		await user.click(screen.getByRole('button', { name: 'Cancel' }));
		await expect(promise).resolves.toBe(false);
	});

	it('resolves false on Escape', async () => {
		const user = userEvent.setup();
		render(ConfirmDialog);
		const promise = confirmDialog.ask({ title: 't', message: 'm' });
		await tick();
		await user.keyboard('{Escape}');
		await expect(promise).resolves.toBe(false);
	});

	it('resolves false on backdrop click', async () => {
		render(ConfirmDialog);
		const promise = confirmDialog.ask({ title: 't', message: 'm' });
		await tick();
		// Backdrop click = the alertdialog element itself; the inner panel
		// (which IS event.target when clicked) is a child div, so it doesn't
		// trigger the close. Fire on the backdrop directly.
		const backdrop = screen.getByRole('alertdialog');
		await fireEvent.click(backdrop);
		await expect(promise).resolves.toBe(false);
	});

	it('does NOT close when the inner panel is clicked', async () => {
		const user = userEvent.setup();
		render(ConfirmDialog);
		const promise = confirmDialog.ask({ title: 't', message: 'm' });
		await tick();
		// Click on the title text — that's inside the inner panel, not the
		// backdrop. Should not resolve the promise.
		await user.click(screen.getByText('t'));
		// Need a way to assert "promise is still pending" — race against a
		// short timer.
		const pending = Promise.race([
			promise.then(() => 'resolved'),
			new Promise((r) => setTimeout(() => r('pending'), 30))
		]);
		await expect(pending).resolves.toBe('pending');
		// Clean up so afterEach's cancel doesn't have to resolve it twice.
		confirmDialog.cancel();
		await promise;
	});

	it('chained asks resolve the previous as cancelled', async () => {
		render(ConfirmDialog);
		const first = confirmDialog.ask({ title: 'first', message: 'm' });
		await tick();
		// Open a second dialog before resolving the first. The store's
		// ask() resolves the prior pending as false to keep its awaiter
		// from hanging.
		const second = confirmDialog.ask({ title: 'second', message: 'm' });
		await tick();
		await expect(first).resolves.toBe(false);
		expect(screen.getByText('second')).toBeInTheDocument();
		confirmDialog.cancel();
		await second;
	});
});
