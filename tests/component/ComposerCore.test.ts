/* @vitest-environment happy-dom */

/**
 * Component test for ComposerCore — the shared composer input box used by
 * both ChatComposer and the home page. Pins the input mechanics that used
 * to be duplicated: textarea + auto-resize, attach/file-input, drag-drop,
 * paste, Enter/submit routing, and focus().
 *
 * The `controls` snippet (the consumer's trailing buttons) is supplied via
 * createRawSnippet — here just a submit button so we can exercise form
 * submission.
 */

import { describe, expect, it, vi } from 'vitest';
import { createRawSnippet } from 'svelte';
import { render, screen, fireEvent } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import ComposerCore from '$lib/components/chat/ComposerCore.svelte';
import type { AttachmentStore } from '$lib/attachments.svelte';

function makeStore(overrides: Partial<AttachmentStore> = {}): AttachmentStore {
	return {
		items: [],
		isBusy: false,
		addFiles: vi.fn(),
		remove: vi.fn(),
		...overrides,
	} as unknown as AttachmentStore;
}

// A minimal controls snippet: a submit button (to test form submit) plus a
// marker so we can confirm the snippet renders into the action row.
const controls = createRawSnippet(() => ({
	render: () => `<button type="submit" aria-label="Stub send" data-testid="ctrl">go</button>`,
}));

function baseProps(overrides: Record<string, unknown> = {}) {
	return {
		text: '',
		attachments: makeStore(),
		allowAttachments: true,
		disabled: false,
		placeholder: 'Write a message…',
		enterBehavior: 'send' as const,
		onSubmit: vi.fn(),
		controls,
		...overrides,
	};
}

function imageFile(name = 'a.png') {
	return new File(['x'], name, { type: 'image/png' });
}
function fakeTransfer(files: File[], types = ['Files']) {
	return { types, files, items: [] };
}

describe('ComposerCore — textarea', () => {
	it('renders the textarea with the placeholder', () => {
		render(ComposerCore, { props: baseProps() });
		expect(screen.getByPlaceholderText('Write a message…')).toBeInTheDocument();
	});

	it('honors the disabled prop', () => {
		render(ComposerCore, { props: baseProps({ disabled: true }) });
		expect(screen.getByPlaceholderText('Write a message…')).toBeDisabled();
	});

	it('honors a custom rows value', () => {
		render(ComposerCore, { props: baseProps({ rows: 2 }) });
		expect(screen.getByPlaceholderText('Write a message…')).toHaveAttribute('rows', '2');
	});

	it('renders the supplied controls snippet into the action row', () => {
		render(ComposerCore, { props: baseProps() });
		expect(screen.getByTestId('ctrl')).toBeInTheDocument();
	});
});

describe('ComposerCore — submit routing', () => {
	it('fires onSubmit when the form is submitted (submit button in controls)', async () => {
		const user = userEvent.setup();
		const onSubmit = vi.fn();
		render(ComposerCore, { props: baseProps({ onSubmit }) });
		await user.click(screen.getByRole('button', { name: 'Stub send' }));
		expect(onSubmit).toHaveBeenCalledTimes(1);
	});

	it('fires onSubmit on Enter with send behavior', async () => {
		const user = userEvent.setup();
		const onSubmit = vi.fn();
		render(ComposerCore, { props: baseProps({ onSubmit, enterBehavior: 'send' }) });
		const ta = screen.getByPlaceholderText('Write a message…');
		ta.focus();
		await user.keyboard('{Enter}');
		expect(onSubmit).toHaveBeenCalledTimes(1);
	});

	it('does NOT submit on Enter with newline behavior', async () => {
		const user = userEvent.setup();
		const onSubmit = vi.fn();
		render(ComposerCore, { props: baseProps({ onSubmit, enterBehavior: 'newline' }) });
		const ta = screen.getByPlaceholderText('Write a message…');
		ta.focus();
		await user.keyboard('{Enter}');
		expect(onSubmit).not.toHaveBeenCalled();
	});
});

describe('ComposerCore — attachments', () => {
	it('shows the attach button when allowAttachments', () => {
		render(ComposerCore, { props: baseProps() });
		expect(screen.getByRole('button', { name: 'Attach file' })).toBeInTheDocument();
	});

	it('hides the attach button when not allowAttachments', () => {
		render(ComposerCore, { props: baseProps({ allowAttachments: false }) });
		expect(screen.queryByRole('button', { name: 'Attach file' })).toBeNull();
	});

	it('adds picked files to the attachment store', async () => {
		const user = userEvent.setup();
		const store = makeStore();
		const { container } = render(ComposerCore, { props: baseProps({ attachments: store }) });
		const input = container.querySelector('input[type="file"]') as HTMLInputElement;
		await user.upload(input, imageFile());
		expect(store.addFiles).toHaveBeenCalled();
	});
});

describe('ComposerCore — drag-drop', () => {
	it('shows the drop overlay on drag enter', async () => {
		const { container } = render(ComposerCore, { props: baseProps() });
		const form = container.querySelector('form')!;
		await fireEvent.dragEnter(form, { dataTransfer: fakeTransfer([imageFile()]) });
		expect(screen.getByText('Drop image to attach')).toBeInTheDocument();
	});

	it('hides the overlay again on drag leave', async () => {
		const { container } = render(ComposerCore, { props: baseProps() });
		const form = container.querySelector('form')!;
		await fireEvent.dragEnter(form, { dataTransfer: fakeTransfer([imageFile()]) });
		await fireEvent.dragLeave(form, { dataTransfer: fakeTransfer([imageFile()]) });
		expect(screen.queryByText('Drop image to attach')).toBeNull();
	});

	it('adds dropped image files to the store', async () => {
		const store = makeStore();
		const { container } = render(ComposerCore, { props: baseProps({ attachments: store }) });
		const form = container.querySelector('form')!;
		await fireEvent.drop(form, { dataTransfer: fakeTransfer([imageFile()]) });
		expect(store.addFiles).toHaveBeenCalled();
	});

	it('ignores drags when attachments are not allowed', async () => {
		const { container } = render(ComposerCore, { props: baseProps({ allowAttachments: false }) });
		const form = container.querySelector('form')!;
		await fireEvent.dragEnter(form, { dataTransfer: fakeTransfer([imageFile()]) });
		expect(screen.queryByText('Drop image to attach')).toBeNull();
	});
});

describe('ComposerCore — paste', () => {
	it('consumes a pasted image into the store', async () => {
		const store = makeStore();
		render(ComposerCore, { props: baseProps({ attachments: store }) });
		const ta = screen.getByPlaceholderText('Write a message…');
		await fireEvent.paste(ta, { clipboardData: fakeTransfer([imageFile()]) });
		expect(store.addFiles).toHaveBeenCalled();
	});

	it('lets a plain-text paste fall through (no addFiles)', async () => {
		const store = makeStore();
		render(ComposerCore, { props: baseProps({ attachments: store }) });
		const ta = screen.getByPlaceholderText('Write a message…');
		await fireEvent.paste(ta, { clipboardData: { types: ['text/plain'], files: [], items: [] } });
		expect(store.addFiles).not.toHaveBeenCalled();
	});
});

describe('ComposerCore — focus()', () => {
	it('exposes a focus() that focuses the textarea', () => {
		const { component } = render(ComposerCore, { props: baseProps() }) as unknown as {
			component: { focus: () => void };
		};
		component.focus();
		expect(screen.getByPlaceholderText('Write a message…')).toHaveFocus();
	});
});
