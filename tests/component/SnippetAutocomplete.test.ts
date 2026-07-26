/* @vitest-environment happy-dom */

/**
 * Component test for the prompt-snippet autocomplete, driven through
 * ComposerCore (its real host) so the caret-sync wiring and the keydown chain
 * are exercised together rather than in isolation.
 *
 * NOTE ON INSERTION: happy-dom does not implement `document.execCommand`, so
 * every insertion here goes through `replaceRange`'s setRangeText fallback.
 * That verifies the *text* result but NOT the single-undo behavior, which is
 * the entire reason the production path uses execCommand. Atomic undo is
 * covered in tests/e2e/prompt-snippets.spec.ts, where a real browser has a
 * real undo stack.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createRawSnippet } from 'svelte';
import { render, screen, fireEvent } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import ComposerCore from '$lib/components/chat/ComposerCore.svelte';
import { invalidateSnippets } from '$lib/prompt-snippets.svelte';
import type { AttachmentStore } from '$lib/attachments.svelte';
import type { PromptSnippet } from '$lib/types/api';

function snip(over: Partial<PromptSnippet> & { name: string }): PromptSnippet {
	return {
		id: over.name,
		body: `BODY(${over.name})`,
		kinds: [],
		tags: [],
		usageCount: 0,
		createdAt: 0,
		updatedAt: 0,
		...over,
	};
}

const LIBRARY: PromptSnippet[] = [
	snip({ name: 'Toriyama', kinds: ['image'], body: 'clean readable linework' }),
	snip({ name: 'Anime', kinds: ['image'] }),
	snip({ name: 'Cinematic', kinds: ['video'] }),
	snip({ name: 'Terse' }), // generic
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
		...overrides,
	};
}

/** The store fetches lazily on first trigger; stub the endpoint it calls. */
function stubLibrary(snippets: PromptSnippet[] = LIBRARY) {
	vi.stubGlobal(
		'fetch',
		vi.fn(async (url: string) => {
			// endsWith, not includes: '/api/user/...' contains '/use' inside
			// '/user/', which would swallow the list request.
			if (String(url).endsWith('/use')) return new Response(null, { status: 204 });
			return new Response(JSON.stringify({ promptSnippets: snippets }), {
				status: 200,
				headers: { 'content-type': 'application/json' },
			});
		}),
	);
}

/** Wait for the lazy fetch + the resulting re-render. Uses testing-library's
 *  async query rather than vi.waitFor, which doesn't flush Svelte's effect
 *  queue and so never observes the menu appearing. */
async function settle() {
	await screen.findByRole('listbox', { name: 'Prompt snippets' });
}

beforeEach(() => {
	invalidateSnippets(); // module-level cache is shared across tests
	stubLibrary();
});

/** The name is the inner span of each option's header row (the outer span also
 *  holds the kind chips, and the option's full text includes the body
 *  preview). */
const optionNames = () =>
	screen
		.getAllByRole('option')
		.map((el) => el.querySelector('span > span')?.textContent?.trim() ?? '');

describe('SnippetAutocomplete — opening', () => {
	it('opens on a trigger typed at the start of the draft', async () => {
		const user = userEvent.setup();
		render(ComposerCore, { props: baseProps() });
		await user.type(screen.getByPlaceholderText('Write a message…'), ';');
		await settle();
		expect(screen.getByRole('listbox', { name: 'Prompt snippets' })).toBeInTheDocument();
	});

	it('opens mid-message after a space and filters by the query', async () => {
		const user = userEvent.setup();
		render(ComposerCore, { props: baseProps() });
		await user.type(screen.getByPlaceholderText('Write a message…'), 'A cat in ;tori');
		await settle();
		expect(optionNames()).toEqual(['Toriyama']);
	});

	it('matches a substring, not just a prefix', async () => {
		const user = userEvent.setup();
		render(ComposerCore, { props: baseProps() });
		await user.type(screen.getByPlaceholderText('Write a message…'), ';yama');
		await settle();
		expect(optionNames()).toEqual(['Toriyama']);
	});

	it('stays closed for a semicolon that follows a word', async () => {
		const user = userEvent.setup();
		render(ComposerCore, { props: baseProps() });
		await user.type(screen.getByPlaceholderText('Write a message…'), 'const x = 1;');
		expect(screen.queryByRole('listbox')).toBeNull();
	});

	it('closes once whitespace is typed past the query', async () => {
		const user = userEvent.setup();
		render(ComposerCore, { props: baseProps() });
		const ta = screen.getByPlaceholderText('Write a message…');
		await user.type(ta, ';tori');
		await settle();
		await user.type(ta, ' ');
		expect(screen.queryByRole('listbox')).toBeNull();
	});

	it('shows nothing when the query matches no snippet', async () => {
		const user = userEvent.setup();
		render(ComposerCore, { props: baseProps() });
		await user.type(screen.getByPlaceholderText('Write a message…'), ';zzzz');
		expect(screen.queryByRole('listbox')).toBeNull();
	});
});

describe('SnippetAutocomplete — modality filtering', () => {
	it('hides other modalities but keeps generic snippets', async () => {
		const user = userEvent.setup();
		render(ComposerCore, { props: baseProps({ activeKind: 'chat' }) });
		await user.type(screen.getByPlaceholderText('Write a message…'), ';');
		await settle();
		expect(optionNames()).toEqual(['Terse']);
	});

	it('shows the active modality plus generic', async () => {
		const user = userEvent.setup();
		render(ComposerCore, { props: baseProps({ activeKind: 'image' }) });
		await user.type(screen.getByPlaceholderText('Write a message…'), ';');
		await settle();
		expect(optionNames().sort()).toEqual(['Anime', 'Terse', 'Toriyama']);
	});

	// The escape hatch: the filter suppresses clutter, never everything.
	it('falls back to an off-kind match rather than showing an empty menu', async () => {
		const user = userEvent.setup();
		render(ComposerCore, { props: baseProps({ activeKind: 'chat' }) });
		await user.type(screen.getByPlaceholderText('Write a message…'), ';tori');
		await settle();
		expect(optionNames()).toEqual(['Toriyama']);
	});
});

describe('SnippetAutocomplete — keyboard', () => {
	it('inserts the body on Enter without submitting', async () => {
		const user = userEvent.setup();
		const onSubmit = vi.fn();
		render(ComposerCore, { props: baseProps({ onSubmit }) });
		const ta = screen.getByPlaceholderText('Write a message…') as HTMLTextAreaElement;
		await user.type(ta, ';tori');
		await settle();
		await user.keyboard('{Enter}');
		expect(ta.value).toBe('clean readable linework');
		expect(onSubmit).not.toHaveBeenCalled();
	});

	it('inserts at the caret, preserving the surrounding text', async () => {
		const user = userEvent.setup();
		render(ComposerCore, { props: baseProps() });
		const ta = screen.getByPlaceholderText('Write a message…') as HTMLTextAreaElement;
		await user.type(ta, 'Style: ;tori');
		await settle();
		await user.keyboard('{Enter}');
		expect(ta.value).toBe('Style: clean readable linework');
	});

	it('arrows through the list and inserts the highlighted entry', async () => {
		const user = userEvent.setup();
		render(ComposerCore, { props: baseProps({ activeKind: 'image' }) });
		const ta = screen.getByPlaceholderText('Write a message…') as HTMLTextAreaElement;
		await user.type(ta, ';');
		await settle();
		const first = optionNames()[0];
		await user.keyboard('{ArrowDown}');
		const second = optionNames()[1];
		expect(second).not.toBe(first);
		await user.keyboard('{Enter}');
		expect(ta.value).toBe(`BODY(${second})`);
	});

	it('closes on Escape without inserting', async () => {
		const user = userEvent.setup();
		render(ComposerCore, { props: baseProps() });
		const ta = screen.getByPlaceholderText('Write a message…') as HTMLTextAreaElement;
		await user.type(ta, ';tori');
		await settle();
		await user.keyboard('{Escape}');
		expect(screen.queryByRole('listbox')).toBeNull();
		expect(ta.value).toBe(';tori');
	});

	it('lets Enter submit normally when the menu is closed', async () => {
		const user = userEvent.setup();
		const onSubmit = vi.fn();
		render(ComposerCore, { props: baseProps({ onSubmit }) });
		await user.type(screen.getByPlaceholderText('Write a message…'), 'plain message');
		await user.keyboard('{Enter}');
		expect(onSubmit).toHaveBeenCalledTimes(1);
	});

	it('supports stacking two snippets in one draft', async () => {
		const user = userEvent.setup();
		render(ComposerCore, { props: baseProps() });
		const ta = screen.getByPlaceholderText('Write a message…') as HTMLTextAreaElement;
		await user.type(ta, ';tori');
		await settle();
		await user.keyboard('{Enter}');
		await user.type(ta, ' ;terse');
		await settle();
		await user.keyboard('{Enter}');
		expect(ta.value).toBe('clean readable linework BODY(Terse)');
	});
});

// The caret is the likeliest source of a stale-menu bug: a $derived on `text`
// alone would not re-run when the caret moves without an edit.
describe('SnippetAutocomplete — caret tracking', () => {
	it('re-reads the caret after a click moves it', async () => {
		const user = userEvent.setup();
		render(ComposerCore, { props: baseProps() });
		const ta = screen.getByPlaceholderText('Write a message…') as HTMLTextAreaElement;
		await user.type(ta, ';tori and more text');
		expect(screen.queryByRole('listbox')).toBeNull();

		// Put the caret back inside the ';tori' token and re-fire the events a
		// real click produces.
		ta.setSelectionRange(5, 5);
		await fireEvent.click(ta);
		await settle();
		expect(optionNames()).toEqual(['Toriyama']);
	});

	// Regression: not every change to `text` arrives with an event. The chat
	// page swaps the draft on conversation switch, the gallery hands over a
	// prompt, an undo toast restores a previous draft — all assign through
	// `bind:value`, which does not dispatch `input`. The caret would keep
	// indexing into text that is no longer there.
	// The replacement text is chosen so the STALE caret would still land on a
	// matching trigger: after typing ';tori' the caret is 5, and in 'ab ;tori…'
	// scanning back from index 4 finds the `;` at 3 and yields query 't', which
	// matches several fixtures. So the menu closing here can only be the
	// staleness guard — not an incidental miss.
	it('closes when text is replaced programmatically, without an event', async () => {
		const user = userEvent.setup();
		const { rerender } = render(ComposerCore, { props: baseProps() });
		await user.type(screen.getByPlaceholderText('Write a message…'), ';tori');
		await settle();

		await rerender(baseProps({ text: 'ab ;tori and more' }));

		expect(screen.queryByRole('listbox')).toBeNull();
	});

	it('reopens normally once the user interacts with the new text', async () => {
		const user = userEvent.setup();
		const { rerender } = render(ComposerCore, { props: baseProps() });
		const ta = screen.getByPlaceholderText('Write a message…') as HTMLTextAreaElement;
		await user.type(ta, ';tori');
		await settle();
		await rerender(baseProps({ text: 'ab ;tori and more' }));
		expect(screen.queryByRole('listbox')).toBeNull();

		// A real keystroke re-establishes caret and value together.
		await user.type(ta, ' ;tori');
		await settle();
		expect(optionNames()).toEqual(['Toriyama']);
	});

	it('closes when the caret leaves the token', async () => {
		const user = userEvent.setup();
		render(ComposerCore, { props: baseProps() });
		const ta = screen.getByPlaceholderText('Write a message…') as HTMLTextAreaElement;
		await user.type(ta, ';tori');
		await settle();
		ta.setSelectionRange(0, 0);
		await fireEvent.click(ta);
		expect(screen.queryByRole('listbox')).toBeNull();
	});
});

describe('SnippetAutocomplete — opt-out and laziness', () => {
	it('never opens when allowSnippets is false', async () => {
		const user = userEvent.setup();
		render(ComposerCore, { props: baseProps({ allowSnippets: false }) });
		await user.type(screen.getByPlaceholderText('Write a message…'), ';tori');
		expect(screen.queryByRole('listbox')).toBeNull();
	});

	it('does not fetch the library until a trigger is typed', async () => {
		const user = userEvent.setup();
		render(ComposerCore, { props: baseProps() });
		await user.type(screen.getByPlaceholderText('Write a message…'), 'an ordinary message');
		expect(fetch).not.toHaveBeenCalled();

		await user.type(screen.getByPlaceholderText('Write a message…'), ' ;');
		await settle();
		expect(fetch).toHaveBeenCalled();
	});

	it('fetches the library only once across repeated triggers', async () => {
		const user = userEvent.setup();
		render(ComposerCore, { props: baseProps() });
		const ta = screen.getByPlaceholderText('Write a message…');
		await user.type(ta, ';a');
		await settle();
		await user.clear(ta);
		await user.type(ta, ';t');
		await settle();
		const listCalls = (fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls.filter(
			(c) => !String(c[0]).endsWith('/use'),
		);
		expect(listCalls).toHaveLength(1);
	});
});
