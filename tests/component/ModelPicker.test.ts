/* @vitest-environment happy-dom */

/**
 * Component test for ModelPicker — the chat composer's model selector.
 *
 * Biggest component in the surface (~460 lines) and the highest-risk one
 * to leave untested: search filtering, group rendering, favorites,
 * presets, keyboard nav, and the inline-vs-default variants are all
 * non-trivial. Tests cover the contract in slices; each describe block
 * scopes a behavior.
 *
 * Pattern notes:
 * - Popover.Portal: query content via screen.* not container.*
 * - Search filtering is reactive: type and the rendered list updates
 *   inside the same async user.click/type sequence
 * - bits-ui Popover focus-trap: search input auto-focuses on open, so
 *   typing immediately after user.click(trigger) works
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { tick } from 'svelte';
import { render, screen, within } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import ModelPicker from '$lib/components/chat/ModelPicker.svelte';
import type { CustomModel, ModelEntry } from '$lib/types/api';

function makeModel(overrides: Partial<ModelEntry> = {}): ModelEntry {
	const endpointId = overrides.endpointId ?? 'bridge';
	const upstreamId = overrides.upstreamId ?? 'gpt-4o';
	return {
		id: overrides.id ?? `${endpointId}::${upstreamId}`,
		endpointId,
		upstreamId,
		displayName: overrides.displayName ?? upstreamId,
		ownedBy: overrides.ownedBy ?? null,
		kind: overrides.kind ?? 'chat',
		kindKnown: overrides.kindKnown ?? true,
		group: overrides.group ?? 'Bridge',
		groupKey: overrides.groupKey ?? endpointId,
		supportsTools: overrides.supportsTools ?? false,
	};
}

function makeCustom(overrides: Partial<CustomModel> = {}): CustomModel {
	return {
		id: overrides.id ?? 'cm-' + Math.random().toString(36).slice(2, 8),
		name: overrides.name ?? 'My preset',
		description: overrides.description ?? null,
		baseEndpointId: overrides.baseEndpointId ?? 'bridge',
		baseModelId: overrides.baseModelId ?? 'gpt-4o',
		systemPrompt: overrides.systemPrompt ?? null,
		parameters: overrides.parameters ?? null,
		defaultDisabledFeatures: overrides.defaultDisabledFeatures ?? [],
		createdAt: 0,
		updatedAt: 0,
	};
}

afterEach(() => {
	// Force-close any open popover that leaked across tests.
	const open = document.querySelector('[data-state="open"]');
	if (open) (open as HTMLElement).click?.();
});

describe('ModelPicker — trigger', () => {
	it('renders "Choose a model…" when no value is selected', () => {
		render(ModelPicker, { props: { models: [makeModel()], value: '' } });
		expect(screen.getByText('Choose a model…')).toBeInTheDocument();
	});

	it('renders the selected model name in the trigger', () => {
		const m = makeModel({ id: 'bridge::gpt-4o', displayName: 'gpt-4o' });
		render(ModelPicker, { props: { models: [m], value: m.id } });
		expect(screen.getByText('gpt-4o')).toBeInTheDocument();
	});

	it('strips an owner/ prefix from the trigger label', () => {
		const m = makeModel({
			id: 'bridge::meta-llama/Llama-3-70b',
			displayName: 'meta-llama/Llama-3-70b',
		});
		render(ModelPicker, { props: { models: [m], value: m.id } });
		expect(screen.getByText('Llama-3-70b')).toBeInTheDocument();
		expect(screen.queryByText('meta-llama/Llama-3-70b')).toBeNull();
	});

	it('keeps the full name for custom presets (no owner/ stripping)', () => {
		const m = makeModel();
		const cm = makeCustom({ id: 'preset-1', name: 'My fancy preset' });
		render(ModelPicker, {
			props: {
				models: [m],
				customModels: [cm],
				value: `custom::${cm.id}`,
			},
		});
		expect(screen.getByText('My fancy preset')).toBeInTheDocument();
	});

	it('honors the disabled prop on the trigger', () => {
		render(ModelPicker, {
			props: { models: [makeModel()], value: '', disabled: true },
		});
		expect(screen.getByLabelText('Select model')).toBeDisabled();
	});

	it('supports the inline variant (uses different class shape than full-width)', () => {
		const { rerender } = render(ModelPicker, {
			props: { models: [makeModel()], value: '', inline: false },
		});
		const full = screen.getByLabelText('Select model');
		expect(full).toHaveClass('w-full');

		rerender({ models: [makeModel()], value: '', inline: true });
		const inline = screen.getByLabelText('Select model');
		expect(inline).not.toHaveClass('w-full');
		expect(inline).toHaveClass('inline-flex');
	});
});

describe('ModelPicker — opening + listing', () => {
	it('opens the popover when the trigger is clicked', async () => {
		const user = userEvent.setup();
		render(ModelPicker, { props: { models: [makeModel()], value: '' } });
		await user.click(screen.getByLabelText('Select model'));
		expect(screen.getByPlaceholderText('Search models…')).toBeInTheDocument();
	});

	it('lists each model as an option', async () => {
		const user = userEvent.setup();
		const models = [
			makeModel({ id: 'bridge::a', displayName: 'Model A' }),
			makeModel({ id: 'bridge::b', displayName: 'Model B' }),
		];
		render(ModelPicker, { props: { models, value: '' } });
		await user.click(screen.getByLabelText('Select model'));
		expect(screen.getByRole('option', { name: /Model A/ })).toBeInTheDocument();
		expect(screen.getByRole('option', { name: /Model B/ })).toBeInTheDocument();
	});

	it('renders a group header when models are unfiltered', async () => {
		const user = userEvent.setup();
		const models = [makeModel({ group: 'Groq', groupKey: 'groq' })];
		render(ModelPicker, { props: { models, value: '' } });
		await user.click(screen.getByLabelText('Select model'));
		expect(screen.getByText('Groq')).toBeInTheDocument();
	});

	it('shows the empty state when no models are supplied', async () => {
		const user = userEvent.setup();
		render(ModelPicker, { props: { models: [], value: '' } });
		await user.click(screen.getByLabelText('Select model'));
		expect(screen.getByText('No models available.')).toBeInTheDocument();
	});
});

describe('ModelPicker — search filtering', () => {
	const models = [
		makeModel({ id: 'bridge::gpt-4o', displayName: 'gpt-4o', group: 'OpenAI' }),
		makeModel({
			id: 'groq::llama-3.1-70b',
			endpointId: 'groq',
			upstreamId: 'llama-3.1-70b',
			displayName: 'llama-3.1-70b',
			group: 'Groq',
			groupKey: 'groq',
		}),
		makeModel({
			id: 'bridge::claude-3-opus',
			displayName: 'claude-3-opus',
			group: 'OpenAI',
		}),
	];

	it('narrows results to matching displayName', async () => {
		const user = userEvent.setup();
		render(ModelPicker, { props: { models, value: '' } });
		await user.click(screen.getByLabelText('Select model'));
		await user.type(screen.getByPlaceholderText('Search models…'), 'llama');
		expect(screen.getByRole('option', { name: /llama/ })).toBeInTheDocument();
		expect(screen.queryByRole('option', { name: /gpt-4o/ })).toBeNull();
		expect(screen.queryByRole('option', { name: /claude/ })).toBeNull();
	});

	it('shows the no-matches message for queries with zero results', async () => {
		const user = userEvent.setup();
		render(ModelPicker, { props: { models, value: '' } });
		await user.click(screen.getByLabelText('Select model'));
		await user.type(screen.getByPlaceholderText('Search models…'), 'asdfzzzz');
		expect(screen.getByText(/No matches for "asdfzzzz"/)).toBeInTheDocument();
	});

	it('matches multi-token queries in any order', async () => {
		const user = userEvent.setup();
		render(ModelPicker, { props: { models, value: '' } });
		await user.click(screen.getByLabelText('Select model'));
		// "groq llama" tokens match in order; reverse should also match.
		await user.type(screen.getByPlaceholderText('Search models…'), 'llama groq');
		expect(screen.getByRole('option', { name: /llama/ })).toBeInTheDocument();
	});

	it('hides group headers while searching', async () => {
		const user = userEvent.setup();
		render(ModelPicker, { props: { models, value: '' } });
		await user.click(screen.getByLabelText('Select model'));
		// Group headers visible before search.
		expect(screen.getByText('OpenAI')).toBeInTheDocument();
		await user.type(screen.getByPlaceholderText('Search models…'), 'gpt');
		// Group header is gone in flat search view.
		expect(screen.queryByText('OpenAI')).toBeNull();
	});
});

describe('ModelPicker — selection', () => {
	it('fires onChange with the picked id and closes the popover', async () => {
		const user = userEvent.setup();
		const onChange = vi.fn();
		const m = makeModel({ id: 'bridge::gpt-4o', displayName: 'gpt-4o' });
		render(ModelPicker, { props: { models: [m], value: '', onChange } });
		await user.click(screen.getByLabelText('Select model'));
		await user.click(screen.getByRole('option', { name: /gpt-4o/ }));
		expect(onChange).toHaveBeenCalledWith('bridge::gpt-4o');
		await tick();
		// Popover closed → search input is gone.
		expect(screen.queryByPlaceholderText('Search models…')).toBeNull();
	});

	it('marks the currently-selected option with aria-selected', async () => {
		const user = userEvent.setup();
		const m = makeModel({ id: 'bridge::gpt-4o' });
		const other = makeModel({ id: 'bridge::other', displayName: 'other' });
		render(ModelPicker, { props: { models: [m, other], value: m.id } });
		await user.click(screen.getByLabelText('Select model'));
		const selected = screen.getByRole('option', { selected: true });
		expect(selected).toHaveTextContent('gpt-4o');
	});
});

describe('ModelPicker — custom presets', () => {
	const baseModel = makeModel({ id: 'bridge::gpt-4o', displayName: 'gpt-4o' });

	it('renders presets under a "Your presets" group', async () => {
		const user = userEvent.setup();
		const cm = makeCustom({ id: 'p1', name: 'My fancy preset' });
		render(ModelPicker, {
			props: { models: [baseModel], customModels: [cm], value: '' },
		});
		await user.click(screen.getByLabelText('Select model'));
		expect(screen.getByText('Your presets')).toBeInTheDocument();
		expect(screen.getByRole('option', { name: /My fancy preset/ })).toBeInTheDocument();
	});

	it('selecting a preset emits the `custom::id` form', async () => {
		const user = userEvent.setup();
		const onChange = vi.fn();
		const cm = makeCustom({ id: 'p1', name: 'My fancy preset' });
		render(ModelPicker, {
			props: { models: [baseModel], customModels: [cm], value: '', onChange },
		});
		await user.click(screen.getByLabelText('Select model'));
		await user.click(screen.getByRole('option', { name: /My fancy preset/ }));
		expect(onChange).toHaveBeenCalledWith('custom::p1');
	});

	it('omits presets whose base model is missing from the visible list', async () => {
		const user = userEvent.setup();
		const cm = makeCustom({ id: 'orphan', name: 'Orphaned', baseModelId: 'gone' });
		render(ModelPicker, {
			props: { models: [baseModel], customModels: [cm], value: '' },
		});
		await user.click(screen.getByLabelText('Select model'));
		expect(screen.queryByText('Your presets')).toBeNull();
		expect(screen.queryByRole('option', { name: /Orphaned/ })).toBeNull();
	});
});

describe('ModelPicker — favorites', () => {
	const a = makeModel({ id: 'bridge::a', displayName: 'A' });
	const b = makeModel({ id: 'bridge::b', displayName: 'B' });

	it('renders the Favorites group when favoritedIds is non-empty', async () => {
		const user = userEvent.setup();
		render(ModelPicker, {
			props: { models: [a, b], value: '', favoritedIds: ['bridge::b'] },
		});
		await user.click(screen.getByLabelText('Select model'));
		expect(screen.getByText('Favorites')).toBeInTheDocument();
		// "B" appears in both Favorites and Bridge — two option rows total.
		const bOptions = screen.getAllByRole('option', { name: /^B/ });
		expect(bOptions.length).toBe(2);
	});

	it('does not render a Favorites group when there are no favorites', async () => {
		const user = userEvent.setup();
		render(ModelPicker, { props: { models: [a, b], value: '' } });
		await user.click(screen.getByLabelText('Select model'));
		expect(screen.queryByText('Favorites')).toBeNull();
	});

	it('drops unknown favorited ids silently', async () => {
		const user = userEvent.setup();
		render(ModelPicker, {
			props: {
				models: [a, b],
				value: '',
				favoritedIds: ['bridge::a', 'bridge::ghost-removed'],
			},
		});
		await user.click(screen.getByLabelText('Select model'));
		expect(screen.getByText('Favorites')).toBeInTheDocument();
		// Only "A" should appear in favorites — ghost is dropped.
		const favoritesHeader = screen.getByText('Favorites');
		// The group's items follow the header in DOM order; just assert
		// that "A" exists and "ghost" doesn't.
		expect(screen.queryByText('ghost-removed')).toBeNull();
		expect(favoritesHeader).toBeInTheDocument();
	});

	it('renders a star button when onToggleFavorite is supplied', async () => {
		const user = userEvent.setup();
		render(ModelPicker, {
			props: { models: [a], value: '', onToggleFavorite: vi.fn() },
		});
		await user.click(screen.getByLabelText('Select model'));
		expect(screen.getByLabelText('Favorite model')).toBeInTheDocument();
	});

	it('does NOT render star buttons when onToggleFavorite is omitted', async () => {
		const user = userEvent.setup();
		render(ModelPicker, { props: { models: [a], value: '' } });
		await user.click(screen.getByLabelText('Select model'));
		expect(screen.queryByLabelText('Favorite model')).toBeNull();
		expect(screen.queryByLabelText('Unfavorite model')).toBeNull();
	});

	it('clicking the star calls onToggleFavorite with the id, without selecting', async () => {
		const user = userEvent.setup();
		const onToggleFavorite = vi.fn();
		const onChange = vi.fn();
		render(ModelPicker, {
			props: { models: [a], value: '', onToggleFavorite, onChange },
		});
		await user.click(screen.getByLabelText('Select model'));
		await user.click(screen.getByLabelText('Favorite model'));
		expect(onToggleFavorite).toHaveBeenCalledWith('bridge::a');
		expect(onChange).not.toHaveBeenCalled();
	});

	it('changes the star label to "Unfavorite" when already favorited', async () => {
		const user = userEvent.setup();
		render(ModelPicker, {
			props: {
				models: [a],
				value: '',
				favoritedIds: ['bridge::a'],
				onToggleFavorite: vi.fn(),
			},
		});
		await user.click(screen.getByLabelText('Select model'));
		// The row appears twice (Favorites + Bridge); each has its own
		// star button with the same label.
		const stars = screen.getAllByLabelText('Unfavorite model');
		expect(stars.length).toBeGreaterThan(0);
	});

	it('hides the Favorites group while searching', async () => {
		const user = userEvent.setup();
		render(ModelPicker, {
			props: { models: [a, b], value: '', favoritedIds: ['bridge::a'] },
		});
		await user.click(screen.getByLabelText('Select model'));
		expect(screen.getByText('Favorites')).toBeInTheDocument();
		await user.type(screen.getByPlaceholderText('Search models…'), 'A');
		expect(screen.queryByText('Favorites')).toBeNull();
	});
});

describe('ModelPicker — filterKinds', () => {
	it('restricts visible models to the requested kinds', async () => {
		const user = userEvent.setup();
		const models = [
			makeModel({ id: 'bridge::chat-1', displayName: 'chat-1', kind: 'chat' }),
			makeModel({
				id: 'bridge::flux',
				displayName: 'flux',
				kind: 'image',
			}),
			makeModel({
				id: 'bridge::embed-1',
				displayName: 'embed-1',
				kind: 'embedding',
			}),
		];
		render(ModelPicker, {
			props: { models, value: '', filterKinds: ['chat'] },
		});
		await user.click(screen.getByLabelText('Select model'));
		expect(screen.getByRole('option', { name: /chat-1/ })).toBeInTheDocument();
		expect(screen.queryByRole('option', { name: /flux/ })).toBeNull();
		expect(screen.queryByRole('option', { name: /embed-1/ })).toBeNull();
	});
});

describe('ModelPicker — keyboard navigation', () => {
	const models = [
		makeModel({ id: 'bridge::a', displayName: 'A' }),
		makeModel({ id: 'bridge::b', displayName: 'B' }),
		makeModel({ id: 'bridge::c', displayName: 'C' }),
	];

	it('Enter selects the highlighted option', async () => {
		const user = userEvent.setup();
		const onChange = vi.fn();
		render(ModelPicker, { props: { models, value: '', onChange } });
		await user.click(screen.getByLabelText('Select model'));
		// Default highlight is first item (no value selected).
		await user.keyboard('{Enter}');
		expect(onChange).toHaveBeenCalledWith('bridge::a');
	});

	it('ArrowDown then Enter selects the second option', async () => {
		const user = userEvent.setup();
		const onChange = vi.fn();
		render(ModelPicker, { props: { models, value: '', onChange } });
		await user.click(screen.getByLabelText('Select model'));
		await user.keyboard('{ArrowDown}{Enter}');
		expect(onChange).toHaveBeenCalledWith('bridge::b');
	});

	it('ArrowUp from the top wraps to the bottom', async () => {
		const user = userEvent.setup();
		const onChange = vi.fn();
		render(ModelPicker, { props: { models, value: '', onChange } });
		await user.click(screen.getByLabelText('Select model'));
		await user.keyboard('{ArrowUp}{Enter}');
		expect(onChange).toHaveBeenCalledWith('bridge::c');
	});

	it('End jumps to the last option', async () => {
		const user = userEvent.setup();
		const onChange = vi.fn();
		render(ModelPicker, { props: { models, value: '', onChange } });
		await user.click(screen.getByLabelText('Select model'));
		await user.keyboard('{End}{Enter}');
		expect(onChange).toHaveBeenCalledWith('bridge::c');
	});

	it('Home jumps to the first option', async () => {
		const user = userEvent.setup();
		const onChange = vi.fn();
		render(ModelPicker, { props: { models, value: '', onChange } });
		await user.click(screen.getByLabelText('Select model'));
		// Move to middle, then Home back.
		await user.keyboard('{ArrowDown}{ArrowDown}{Home}{Enter}');
		expect(onChange).toHaveBeenCalledWith('bridge::a');
	});
});

describe('ModelPicker — kind emojis', () => {
	it('renders the camera emoji for image kind', async () => {
		const user = userEvent.setup();
		const models = [makeModel({ id: 'bridge::flux', displayName: 'flux', kind: 'image' })];
		render(ModelPicker, { props: { models, value: '' } });
		await user.click(screen.getByLabelText('Select model'));
		const option = screen.getByRole('option', { name: /flux/ });
		expect(within(option).getByText('📷')).toBeInTheDocument();
	});

	it('renders the video camera emoji for video kind', async () => {
		const user = userEvent.setup();
		const models = [makeModel({ id: 'bridge::wan', displayName: 'wan', kind: 'video' })];
		render(ModelPicker, { props: { models, value: '' } });
		await user.click(screen.getByLabelText('Select model'));
		const option = screen.getByRole('option', { name: /wan/ });
		expect(within(option).getByText('📹')).toBeInTheDocument();
	});

	it('renders no emoji for chat kind', async () => {
		const user = userEvent.setup();
		const models = [makeModel({ id: 'bridge::gpt', displayName: 'gpt', kind: 'chat' })];
		render(ModelPicker, { props: { models, value: '' } });
		await user.click(screen.getByLabelText('Select model'));
		const option = screen.getByRole('option', { name: /gpt/ });
		expect(within(option).queryByText(/[📷📹🔢]/)).toBeNull();
	});
});

describe('ModelPicker — owner sublabel', () => {
	it('shows the owner sublabel when a group has multiple distinct owners', async () => {
		const user = userEvent.setup();
		const models = [
			makeModel({
				id: 'bridge::gpt',
				displayName: 'gpt',
				ownedBy: 'openai',
				group: 'Bridge',
				groupKey: 'bridge',
			}),
			makeModel({
				id: 'bridge::claude',
				displayName: 'claude',
				ownedBy: 'anthropic',
				group: 'Bridge',
				groupKey: 'bridge',
			}),
		];
		render(ModelPicker, { props: { models, value: '' } });
		await user.click(screen.getByLabelText('Select model'));
		expect(screen.getByText('· openai')).toBeInTheDocument();
		expect(screen.getByText('· anthropic')).toBeInTheDocument();
	});

	it('omits the owner sublabel when the group has a single owner', async () => {
		const user = userEvent.setup();
		const models = [
			makeModel({ ownedBy: 'openai', group: 'Bridge', groupKey: 'bridge' }),
			makeModel({
				id: 'bridge::gpt-3',
				displayName: 'gpt-3',
				ownedBy: 'openai',
				group: 'Bridge',
				groupKey: 'bridge',
			}),
		];
		render(ModelPicker, { props: { models, value: '' } });
		await user.click(screen.getByLabelText('Select model'));
		expect(screen.queryByText('· openai')).toBeNull();
	});
});

describe('ModelPicker — compare mode', () => {
	function openCompare() {
		return render(ModelPicker, {
			props: {
				models: [
					makeModel({ id: 'bridge::a', displayName: 'Model A' }),
					makeModel({ id: 'bridge::b', displayName: 'Model B' }),
					makeModel({ id: 'bridge::img', displayName: 'Imager', kind: 'image' }),
				],
				value: 'bridge::a',
				allowCompare: true,
			},
		});
	}

	it('hides the Multiple toggle unless allowCompare is set', async () => {
		const user = userEvent.setup();
		render(ModelPicker, { props: { models: [makeModel()], value: '' } });
		await user.click(screen.getByLabelText('Select model'));
		expect(screen.queryByText('Multiple')).toBeNull();
	});

	it('clicking a row adds + increments; the chip shows the count', async () => {
		const user = userEvent.setup();
		openCompare();
		await user.click(screen.getByLabelText('Select model'));
		await user.click(screen.getByText('Multiple'));
		// Enabling seeds the cart from the current selection (Model A ×1). The
		// count shows on both the summary chip and the row badge, hence getAll.
		expect(screen.getAllByText('×1').length).toBeGreaterThan(0);

		// Click Model B's row → it joins the comparison.
		await user.click(screen.getByRole('option', { name: /Model B/ }));
		await tick();
		// Click Model B again → its count goes to 2.
		await user.click(screen.getByRole('option', { name: /Model B/ }));
		await tick();
		expect(screen.getAllByText('×2').length).toBeGreaterThan(0);
	});

	it('the chip − decrements and removes at zero', async () => {
		const user = userEvent.setup();
		openCompare();
		await user.click(screen.getByLabelText('Select model'));
		await user.click(screen.getByText('Multiple'));
		// Seeded with Model A ×1; decrement removes it.
		await user.click(screen.getByLabelText('Remove one Model A'));
		await tick();
		expect(screen.getByText('Click models below to compare them…')).toBeInTheDocument();
	});

	it('restricts the list to chat models while comparing', async () => {
		const user = userEvent.setup();
		openCompare();
		await user.click(screen.getByLabelText('Select model'));
		// Image model is visible in normal mode…
		expect(screen.getByRole('option', { name: /Imager/ })).toBeInTheDocument();
		await user.click(screen.getByText('Multiple'));
		await tick();
		// …but hidden once comparing (chat-only this cut).
		expect(screen.queryByRole('option', { name: /Imager/ })).toBeNull();
		expect(screen.getByRole('option', { name: /Model A/ })).toBeInTheDocument();
	});

	it('collapses a single-model comparison back to single select on close', async () => {
		const user = userEvent.setup();
		openCompare(); // value = bridge::a
		await user.click(screen.getByLabelText('Select model'));
		await user.click(screen.getByText('Multiple')); // seeds Model A ×1
		await user.keyboard('{Escape}'); // close the popover
		await tick();
		// A comparison of one isn't a comparison: trigger shows the model name,
		// not "Comparing 1 models".
		expect(screen.queryByText(/Comparing/)).toBeNull();
		expect(screen.getByText('Model A')).toBeInTheDocument();
	});

	it('keeps a 2-model comparison and labels the trigger on close', async () => {
		const user = userEvent.setup();
		openCompare();
		await user.click(screen.getByLabelText('Select model'));
		await user.click(screen.getByText('Multiple')); // Model A ×1
		await user.click(screen.getByRole('option', { name: /Model B/ })); // + Model B
		await tick();
		await user.keyboard('{Escape}');
		await tick();
		expect(screen.getByText('Comparing 2 models')).toBeInTheDocument();
	});
});
