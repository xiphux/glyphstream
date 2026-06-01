/* @vitest-environment happy-dom */

/**
 * Component test for BaseDialog — the shared shell for ConfirmDialog
 * and DeleteConversationDialog. Verifies the alertdialog role, Escape
 * handling, and backdrop-vs-panel click discrimination in one place
 * so both callers inherit the contract.
 *
 * BaseDialog is snippet-driven, so we mount it via a tiny harness
 * component that provides a body snippet — testing-library/svelte
 * can't pass snippets through `render`'s props directly.
 */

import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import BaseDialogHarness from './_helpers/BaseDialogHarness.svelte';

describe('BaseDialog', () => {
	it('renders nothing when open=false', () => {
		render(BaseDialogHarness, { props: { open: false, onCancel: vi.fn() } });
		expect(screen.queryByRole('alertdialog')).toBeNull();
	});

	it('renders an alertdialog with aria-modal=true when open=true', () => {
		render(BaseDialogHarness, { props: { open: true, onCancel: vi.fn() } });
		const dialog = screen.getByRole('alertdialog');
		expect(dialog).toBeInTheDocument();
		expect(dialog).toHaveAttribute('aria-modal', 'true');
	});

	it('uses titleId for aria-labelledby and renders the title text', () => {
		render(BaseDialogHarness, {
			props: { open: true, onCancel: vi.fn(), titleId: 't-id', title: 'Hello' },
		});
		const dialog = screen.getByRole('alertdialog');
		expect(dialog).toHaveAttribute('aria-labelledby', 't-id');
		expect(screen.getByText('Hello')).toBeInTheDocument();
	});

	it('renders the body snippet', () => {
		render(BaseDialogHarness, {
			props: { open: true, onCancel: vi.fn(), bodyText: 'Body content here' },
		});
		expect(screen.getByText('Body content here')).toBeInTheDocument();
	});

	it('calls onCancel on Escape', async () => {
		const user = userEvent.setup();
		const onCancel = vi.fn();
		render(BaseDialogHarness, { props: { open: true, onCancel } });
		await user.keyboard('{Escape}');
		expect(onCancel).toHaveBeenCalledTimes(1);
	});

	it('does NOT call onCancel on Escape when open=false', async () => {
		const user = userEvent.setup();
		const onCancel = vi.fn();
		render(BaseDialogHarness, { props: { open: false, onCancel } });
		await user.keyboard('{Escape}');
		expect(onCancel).not.toHaveBeenCalled();
	});

	it('calls onCancel on backdrop click', async () => {
		const onCancel = vi.fn();
		render(BaseDialogHarness, { props: { open: true, onCancel } });
		const backdrop = screen.getByRole('alertdialog');
		await fireEvent.click(backdrop);
		expect(onCancel).toHaveBeenCalledTimes(1);
	});

	it('does NOT call onCancel when the inner panel is clicked', async () => {
		const user = userEvent.setup();
		const onCancel = vi.fn();
		render(BaseDialogHarness, {
			props: { open: true, onCancel, title: 'Title here' },
		});
		await user.click(screen.getByText('Title here'));
		expect(onCancel).not.toHaveBeenCalled();
	});
});
