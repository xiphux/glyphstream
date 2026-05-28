/* @vitest-environment happy-dom */

/**
 * Component test for EditMessageForm — the inline message editor.
 * Uses a minimal AttachmentStore stand-in (items/isBusy/addFiles/remove
 * are all the component + its AttachmentThumbnails child touch).
 */

import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import EditMessageForm from '$lib/components/chat/EditMessageForm.svelte';
import type { AttachmentStore } from '$lib/attachments.svelte';

function makeStore(overrides: Partial<AttachmentStore> = {}): AttachmentStore {
	return {
		items: [],
		isBusy: false,
		addFiles: vi.fn(),
		remove: vi.fn(),
		...overrides
	} as unknown as AttachmentStore;
}

const base = {
	attachments: makeStore(),
	allowAttachments: true,
	enterBehavior: 'send' as const,
	onSave: vi.fn(),
	onCancel: vi.fn()
};

describe('EditMessageForm — rendering', () => {
	it('renders the Editing label + textarea with the current draft', () => {
		render(EditMessageForm, { props: { ...base, editText: 'draft text' } });
		expect(screen.getByText('Editing')).toBeInTheDocument();
		expect(screen.getByRole('textbox')).toHaveValue('draft text');
	});

	it('shows the attach button when allowAttachments', () => {
		render(EditMessageForm, { props: { ...base, editText: 'x' } });
		expect(screen.getByRole('button', { name: 'Attach image' })).toBeInTheDocument();
	});

	it('hides the attach button when not allowAttachments', () => {
		render(EditMessageForm, { props: { ...base, allowAttachments: false, editText: 'x' } });
		expect(screen.queryByRole('button', { name: 'Attach image' })).toBeNull();
	});

	it('focuses the textarea on mount', async () => {
		render(EditMessageForm, { props: { ...base, editText: 'x' } });
		// Focus happens in a tick().then — wait a microtask.
		await Promise.resolve();
		await Promise.resolve();
		expect(screen.getByRole('textbox')).toHaveFocus();
	});
});

describe('EditMessageForm — save enable state', () => {
	it('disables Save when text is empty and there are no attachments', () => {
		render(EditMessageForm, { props: { ...base, editText: '   ' } });
		expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
	});

	it('enables Save when text is non-empty', () => {
		render(EditMessageForm, { props: { ...base, editText: 'hello' } });
		expect(screen.getByRole('button', { name: 'Save' })).not.toBeDisabled();
	});

	it('enables Save with attachments even when text is empty', () => {
		const store = makeStore({ items: [{ clientId: 'a' }] as never });
		render(EditMessageForm, { props: { ...base, attachments: store, editText: '' } });
		expect(screen.getByRole('button', { name: 'Save' })).not.toBeDisabled();
	});

	it('disables Save while attachments are busy uploading', () => {
		const store = makeStore({ items: [{ clientId: 'a' }] as never, isBusy: true });
		render(EditMessageForm, { props: { ...base, attachments: store, editText: 'hello' } });
		expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
	});
});

describe('EditMessageForm — actions', () => {
	it('fires onSave when Save is clicked', async () => {
		const user = userEvent.setup();
		const onSave = vi.fn();
		render(EditMessageForm, { props: { ...base, onSave, editText: 'hi' } });
		await user.click(screen.getByRole('button', { name: 'Save' }));
		expect(onSave).toHaveBeenCalledTimes(1);
	});

	it('fires onCancel when Cancel is clicked', async () => {
		const user = userEvent.setup();
		const onCancel = vi.fn();
		render(EditMessageForm, { props: { ...base, onCancel, editText: 'hi' } });
		await user.click(screen.getByRole('button', { name: 'Cancel' }));
		expect(onCancel).toHaveBeenCalledTimes(1);
	});

	it('fires onCancel on Escape', async () => {
		const user = userEvent.setup();
		const onCancel = vi.fn();
		render(EditMessageForm, { props: { ...base, onCancel, editText: 'hi' } });
		const textarea = screen.getByRole('textbox');
		textarea.focus();
		await user.keyboard('{Escape}');
		expect(onCancel).toHaveBeenCalledTimes(1);
	});

	it('fires onSave on Enter with send behavior', async () => {
		const user = userEvent.setup();
		const onSave = vi.fn();
		render(EditMessageForm, {
			props: { ...base, onSave, enterBehavior: 'send', editText: 'hi' }
		});
		const textarea = screen.getByRole('textbox');
		textarea.focus();
		await user.keyboard('{Enter}');
		expect(onSave).toHaveBeenCalledTimes(1);
	});

	it('does NOT save on Enter with newline behavior', async () => {
		const user = userEvent.setup();
		const onSave = vi.fn();
		render(EditMessageForm, {
			props: { ...base, onSave, enterBehavior: 'newline', editText: 'hi' }
		});
		const textarea = screen.getByRole('textbox');
		textarea.focus();
		await user.keyboard('{Enter}');
		expect(onSave).not.toHaveBeenCalled();
	});
});
