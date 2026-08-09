/* @vitest-environment happy-dom */

/**
 * Component test for the prompt-snippets settings page, focused on the
 * modality quick-filter.
 *
 * The interesting case is the generic snippet (empty `kinds`): the composer
 * offers it on every model, so the page has to count it under every chip. A
 * naive `kinds.includes(k)` would pass every test written only with explicitly
 * kinded fixtures, so the generic fixture is the point of this file rather
 * than an afterthought.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import type { PromptSnippet } from '$lib/types/api';

vi.mock('$app/navigation', () => ({ invalidateAll: vi.fn(), goto: vi.fn() }));

import SnippetsPage from '../../src/routes/(app)/settings/snippets/+page.svelte';

function mk(over: Partial<PromptSnippet> = {}): PromptSnippet {
	return {
		id: over.name ?? 'id',
		name: 'Snippet',
		body: 'body text',
		kinds: [],
		tags: [],
		usageCount: 0,
		createdAt: 0,
		updatedAt: 0,
		...over,
	};
}

const LIB: PromptSnippet[] = [
	mk({ name: 'Akira Toriyama Style', kinds: ['image', 'video'], tags: ['anime'] }),
	mk({ name: 'Anime Style', kinds: ['image'] }),
	mk({ name: 'Cinematic Shot', kinds: ['video'] }),
	mk({ name: 'Grumpy Narrator', kinds: ['chat'] }),
	mk({ name: 'House Rules', kinds: [] }), // generic — applies everywhere
];

function setup(snippets = LIB) {
	return render(SnippetsPage, { props: { data: { promptSnippets: snippets } } });
}

/** Names currently rendered in the library list. */
function listedNames(): string[] {
	const items = screen.queryAllByRole('listitem');
	return items.map((li) => li.querySelector('span.font-medium')?.textContent?.trim() ?? '');
}

function chip(label: string): HTMLElement {
	return screen.getByRole('button', { name: new RegExp(`^${label}\\b`) });
}

beforeEach(() => {
	globalThis.fetch = vi.fn();
});

describe('snippets settings — modality quick-filter', () => {
	it('starts on All, showing every snippet', () => {
		setup();
		expect(listedNames()).toHaveLength(5);
		expect(chip('All')).toHaveAttribute('aria-pressed', 'true');
	});

	it('counts a snippet under every kind it declares', () => {
		setup();
		// image: Toriyama + Anime + generic
		expect(chip('image')).toHaveTextContent('image 3');
		// video: Toriyama + Cinematic + generic
		expect(chip('video')).toHaveTextContent('video 3');
		// chat: Grumpy + generic
		expect(chip('chat')).toHaveTextContent('chat 2');
		expect(chip('All')).toHaveTextContent('All 5');
	});

	it('filters the list to one modality, keeping the generic snippet', async () => {
		const user = userEvent.setup();
		setup();
		await user.click(chip('chat'));
		expect(listedNames().sort()).toEqual(['Grumpy Narrator', 'House Rules']);
		expect(chip('chat')).toHaveAttribute('aria-pressed', 'true');
		expect(chip('All')).toHaveAttribute('aria-pressed', 'false');
	});

	it('excludes snippets of other modalities', async () => {
		const user = userEvent.setup();
		setup();
		await user.click(chip('chat'));
		expect(listedNames()).not.toContain('Anime Style');
		expect(listedNames()).not.toContain('Cinematic Shot');
	});

	it('clicking the active chip returns to All', async () => {
		const user = userEvent.setup();
		setup();
		await user.click(chip('image'));
		expect(listedNames()).toHaveLength(3);
		await user.click(chip('image'));
		expect(listedNames()).toHaveLength(5);
		expect(chip('All')).toHaveAttribute('aria-pressed', 'true');
	});

	it('composes with the text filter', async () => {
		const user = userEvent.setup();
		setup();
		await user.type(screen.getByPlaceholderText(/^Filter 5 snippets/), 'anime');
		// Text-only: Toriyama (tag) + Anime Style (name)
		expect(listedNames().sort()).toEqual(['Akira Toriyama Style', 'Anime Style']);
		await user.click(chip('video'));
		// …now narrowed to the one that also applies to video
		expect(listedNames()).toEqual(['Akira Toriyama Style']);
	});

	it('names the modality when a kind filter alone empties the list', async () => {
		const user = userEvent.setup();
		setup([mk({ name: 'Anime Style', kinds: ['image'] })]);
		await user.click(chip('chat'));
		expect(screen.getByText('No snippets apply to chat.')).toBeTruthy();
	});

	it('names both filters when they combine to empty the list', async () => {
		const user = userEvent.setup();
		setup();
		await user.type(screen.getByPlaceholderText(/^Filter 5 snippets/), 'toriyama');
		await user.click(chip('chat'));
		expect(screen.getByText(/No chat snippets match “toriyama”/)).toBeTruthy();
	});

	it('labels a kind-less snippet "everywhere" rather than rendering no chips', () => {
		setup();
		const row = screen.getByText('House Rules').closest('li')!;
		expect(within(row).getByText('everywhere')).toBeTruthy();
		// …and an explicitly-kinded row does not get the label
		const other = screen.getByText('Anime Style').closest('li')!;
		expect(within(other).queryByText('everywhere')).toBeNull();
	});
});
