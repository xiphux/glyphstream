/* @vitest-environment happy-dom */

/**
 * Component test for SearchModal — covers the open/closed render
 * states, the singleton store contract, debounced fetch, and the
 * empty / no-results paths.
 *
 * The modal owns its singleton (`searchModal.open`), so we drive open
 * + close by mutating the store from the test. `goto` from
 * `$app/navigation` is mocked so result-activation tests don't try
 * to actually navigate (and aren't required to wire the SvelteKit
 * runtime).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';

const mocks = vi.hoisted(() => ({ goto: vi.fn() }));
vi.mock('$app/navigation', () => ({ goto: mocks.goto }));

import SearchModal from '$lib/components/SearchModal.svelte';
import { searchModal } from '$lib/search-modal.svelte';

beforeEach(() => {
	searchModal.hide();
	mocks.goto.mockReset();
	vi.useFakeTimers({ shouldAdvanceTime: true });
});

afterEach(() => {
	vi.useRealTimers();
	searchModal.hide();
});

describe('SearchModal — render states', () => {
	it('renders nothing while the store is closed', () => {
		render(SearchModal);
		expect(screen.queryByRole('dialog')).toBeNull();
	});

	it('renders the dialog with the input when the store opens', async () => {
		render(SearchModal);
		searchModal.show();
		await waitFor(() => expect(screen.getByRole('dialog')).toBeInTheDocument());
		expect(screen.getByPlaceholderText('Search your chats…')).toBeInTheDocument();
	});

	it('shows the empty-state hint when no query has been typed', async () => {
		render(SearchModal);
		searchModal.show();
		await waitFor(() => expect(screen.getByRole('dialog')).toBeInTheDocument());
		expect(screen.getByText(/search your chats/i)).toBeInTheDocument();
	});
});

describe('SearchModal — debounced search', () => {
	it('does not fetch before the debounce delay elapses', async () => {
		const fetchSpy = vi.spyOn(global, 'fetch');
		render(SearchModal);
		searchModal.show();
		await waitFor(() => expect(screen.getByRole('dialog')).toBeInTheDocument());

		const input = screen.getByPlaceholderText('Search your chats…') as HTMLInputElement;
		await userEvent.type(input, 'hello');
		// 250ms debounce window. Advancing 100ms should not have fired.
		vi.advanceTimersByTime(100);
		expect(fetchSpy).not.toHaveBeenCalled();
		fetchSpy.mockRestore();
	});

	it('renders results after a successful fetch', async () => {
		const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue(
			new Response(
				JSON.stringify({
					results: [
						{
							conversationId: 'c1',
							conversationTitle: 'Cooking with onions',
							updatedAt: 1,
							kind: 'message',
							messageId: 'm1',
							snippet: 'a <mark>recipe</mark> here'
						}
					]
				}),
				{ status: 200, headers: { 'Content-Type': 'application/json' } }
			)
		);

		render(SearchModal);
		searchModal.show();
		await waitFor(() => expect(screen.getByRole('dialog')).toBeInTheDocument());

		const input = screen.getByPlaceholderText('Search your chats…') as HTMLInputElement;
		await userEvent.type(input, 'recipe');
		vi.advanceTimersByTime(300);
		await waitFor(() => expect(screen.getByText('Cooking with onions')).toBeInTheDocument());
		fetchSpy.mockRestore();
	});

	it('shows the no-matches state when fetch returns []', async () => {
		const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue(
			new Response(JSON.stringify({ results: [] }), {
				status: 200,
				headers: { 'Content-Type': 'application/json' }
			})
		);
		render(SearchModal);
		searchModal.show();
		await waitFor(() => expect(screen.getByRole('dialog')).toBeInTheDocument());

		const input = screen.getByPlaceholderText('Search your chats…') as HTMLInputElement;
		await userEvent.type(input, 'no-results-here');
		vi.advanceTimersByTime(300);
		await waitFor(() => expect(screen.getByText(/no matches/i)).toBeInTheDocument());
		fetchSpy.mockRestore();
	});
});

describe('SearchModal — activation', () => {
	it('navigates to the deep-link href when a message result is clicked', async () => {
		const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue(
			new Response(
				JSON.stringify({
					results: [
						{
							conversationId: 'c1',
							conversationTitle: 'A',
							updatedAt: 1,
							kind: 'message',
							messageId: 'm42',
							snippet: 'hit'
						}
					]
				}),
				{ status: 200, headers: { 'Content-Type': 'application/json' } }
			)
		);

		render(SearchModal);
		searchModal.show();
		await waitFor(() => expect(screen.getByRole('dialog')).toBeInTheDocument());

		const input = screen.getByPlaceholderText('Search your chats…') as HTMLInputElement;
		await userEvent.type(input, 'hit');
		vi.advanceTimersByTime(300);

		const row = await screen.findByText('A');
		await userEvent.click(row);

		expect(mocks.goto).toHaveBeenCalledWith('/chat/c1#msg-m42');
		// Activating a result also closes the modal.
		expect(searchModal.open).toBe(false);
		fetchSpy.mockRestore();
	});

	it('navigates without a hash for title hits', async () => {
		const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue(
			new Response(
				JSON.stringify({
					results: [
						{
							conversationId: 'c1',
							conversationTitle: 'Title hit',
							updatedAt: 1,
							kind: 'title',
							messageId: null,
							snippet: 'Title <mark>hit</mark>'
						}
					]
				}),
				{ status: 200, headers: { 'Content-Type': 'application/json' } }
			)
		);

		render(SearchModal);
		searchModal.show();
		await waitFor(() => expect(screen.getByRole('dialog')).toBeInTheDocument());

		const input = screen.getByPlaceholderText('Search your chats…') as HTMLInputElement;
		await userEvent.type(input, 'hit');
		vi.advanceTimersByTime(300);

		const row = await screen.findByText('Title hit');
		await userEvent.click(row);

		expect(mocks.goto).toHaveBeenCalledWith('/chat/c1');
		fetchSpy.mockRestore();
	});
});
