/* @vitest-environment happy-dom */

/**
 * Component test for the `/skill-name` autocomplete in ComposerCore.
 *
 * This path shipped without coverage — nothing in the suite passed
 * `skillCommands` — which made it unsafe to refactor. These pin the observable
 * contract (open/filter/keyboard/completion) so the menu shell can be shared
 * with the snippet menu without flying blind.
 *
 * NOTE: completion goes through `replaceRange`, and happy-dom has no
 * `document.execCommand`, so the assertions here exercise the `setRangeText`
 * fallback. The atomic-undo property that motivates execCommand is covered in
 * tests/e2e/prompt-snippets.spec.ts.
 */

import { describe, expect, it, vi } from 'vitest';
import { createRawSnippet } from 'svelte';
import { render, screen } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import ComposerCore from '$lib/components/chat/ComposerCore.svelte';
import type { AttachmentStore } from '$lib/attachments.svelte';

const SKILLS = [
	{ id: '1', name: 'review', description: 'Review a diff' },
	{ id: '2', name: 'refactor', description: 'Refactor code' },
	{ id: '3', name: 'summarize', description: 'Summarize text' },
];

function makeStore(): AttachmentStore {
	return {
		items: [],
		isBusy: false,
		addFiles: vi.fn(),
		remove: vi.fn(),
	} as unknown as AttachmentStore;
}

const controls = createRawSnippet(() => ({
	render: () => `<button type="submit" aria-label="Stub send">go</button>`,
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
		skillCommands: SKILLS,
		...overrides,
	};
}

const optionNames = () =>
	screen.getAllByRole('option').map((el) => el.querySelector('span')?.textContent?.trim() ?? '');

describe('SkillMenu — opening and filtering', () => {
	it('opens on a bare leading slash and lists every skill', async () => {
		const user = userEvent.setup();
		render(ComposerCore, { props: baseProps() });
		await user.type(screen.getByPlaceholderText('Write a message…'), '/');
		expect(screen.getByRole('listbox', { name: 'Skills' })).toBeInTheDocument();
		expect(screen.getAllByRole('option')).toHaveLength(3);
	});

	it('filters by name prefix', async () => {
		const user = userEvent.setup();
		render(ComposerCore, { props: baseProps() });
		await user.type(screen.getByPlaceholderText('Write a message…'), '/re');
		expect(optionNames()).toEqual(['/review', '/refactor']);
	});

	it('closes once a space is typed — the command is locked in', async () => {
		const user = userEvent.setup();
		render(ComposerCore, { props: baseProps() });
		const ta = screen.getByPlaceholderText('Write a message…');
		await user.type(ta, '/review');
		expect(screen.queryByRole('listbox')).not.toBeNull();
		await user.type(ta, ' ');
		expect(screen.queryByRole('listbox')).toBeNull();
	});

	it('does not open for a slash that is not leading', async () => {
		const user = userEvent.setup();
		render(ComposerCore, { props: baseProps() });
		await user.type(screen.getByPlaceholderText('Write a message…'), 'see /review');
		expect(screen.queryByRole('listbox')).toBeNull();
	});

	it('does not open for a path-like token with a second slash', async () => {
		const user = userEvent.setup();
		render(ComposerCore, { props: baseProps() });
		await user.type(screen.getByPlaceholderText('Write a message…'), '/etc/passwd');
		expect(screen.queryByRole('listbox')).toBeNull();
	});

	it('shows no menu when the consumer passes no skills', async () => {
		const user = userEvent.setup();
		render(ComposerCore, { props: baseProps({ skillCommands: undefined }) });
		await user.type(screen.getByPlaceholderText('Write a message…'), '/');
		expect(screen.queryByRole('listbox')).toBeNull();
	});
});

describe('SkillMenu — keyboard', () => {
	it('completes the highlighted name on Enter without submitting', async () => {
		const user = userEvent.setup();
		const onSubmit = vi.fn();
		render(ComposerCore, { props: baseProps({ onSubmit }) });
		const ta = screen.getByPlaceholderText('Write a message…') as HTMLTextAreaElement;
		await user.type(ta, '/rev');
		await user.keyboard('{Enter}');
		expect(ta.value).toBe('/review ');
		expect(onSubmit).not.toHaveBeenCalled();
	});

	it('completes on Tab as well', async () => {
		const user = userEvent.setup();
		render(ComposerCore, { props: baseProps() });
		const ta = screen.getByPlaceholderText('Write a message…') as HTMLTextAreaElement;
		await user.type(ta, '/sum');
		await user.keyboard('{Tab}');
		expect(ta.value).toBe('/summarize ');
	});

	it('arrows through the list and completes the highlighted entry', async () => {
		const user = userEvent.setup();
		render(ComposerCore, { props: baseProps() });
		const ta = screen.getByPlaceholderText('Write a message…') as HTMLTextAreaElement;
		await user.type(ta, '/re');
		await user.keyboard('{ArrowDown}');
		await user.keyboard('{Enter}');
		expect(ta.value).toBe('/refactor ');
	});

	it('wraps around when arrowing past the end', async () => {
		const user = userEvent.setup();
		render(ComposerCore, { props: baseProps() });
		const ta = screen.getByPlaceholderText('Write a message…') as HTMLTextAreaElement;
		await user.type(ta, '/re');
		await user.keyboard('{ArrowDown}{ArrowDown}');
		await user.keyboard('{Enter}');
		expect(ta.value).toBe('/review ');
	});

	it('closes on Escape without completing', async () => {
		const user = userEvent.setup();
		render(ComposerCore, { props: baseProps() });
		const ta = screen.getByPlaceholderText('Write a message…') as HTMLTextAreaElement;
		await user.type(ta, '/rev');
		await user.keyboard('{Escape}');
		expect(screen.queryByRole('listbox')).toBeNull();
		expect(ta.value).toBe('/rev');
	});

	it('lets Enter submit normally when the menu is closed', async () => {
		const user = userEvent.setup();
		const onSubmit = vi.fn();
		render(ComposerCore, { props: baseProps({ onSubmit }) });
		await user.type(screen.getByPlaceholderText('Write a message…'), 'plain message');
		await user.keyboard('{Enter}');
		expect(onSubmit).toHaveBeenCalledTimes(1);
	});
});

describe('SkillMenu — mouse', () => {
	it('completes on click and keeps focus in the textarea', async () => {
		const user = userEvent.setup();
		render(ComposerCore, { props: baseProps() });
		const ta = screen.getByPlaceholderText('Write a message…') as HTMLTextAreaElement;
		await user.type(ta, '/re');
		await user.click(screen.getAllByRole('option')[1]);
		expect(ta.value).toBe('/refactor ');
		expect(ta).toHaveFocus();
	});
});
