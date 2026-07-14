/* @vitest-environment happy-dom */

/**
 * Component test for the custom-models settings page, scoped to the
 * "Default feature toggles" list: it must offer the same categories the
 * composer will actually show for the preset's base model (image models →
 * only the image enhancer, chat models → everything but the enhancers), so
 * an operator can't default-off a toggle that will never be rendered.
 *
 * The rows live inside a closed <details>, which keeps them in the DOM —
 * testing-library queries don't filter on visibility, so no need to open it.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import type { CustomModel, FeatureCategoryEntry, ModelEntry } from '$lib/types/api';

vi.mock('$app/navigation', () => ({ invalidateAll: vi.fn(), goto: vi.fn() }));

import CustomModelsPage from '../../src/routes/(app)/settings/models/+page.svelte';

function makeModel(overrides: Partial<ModelEntry> = {}): ModelEntry {
	const endpointId = overrides.endpointId ?? 'bridge';
	const upstreamId = overrides.upstreamId ?? 'gpt-4o';
	return {
		id: overrides.id ?? `${endpointId}::${upstreamId}`,
		endpointId,
		upstreamId,
		displayName: overrides.displayName ?? upstreamId,
		ownedBy: null,
		kind: overrides.kind ?? 'chat',
		kindKnown: overrides.kindKnown ?? true,
		group: overrides.group ?? 'Bridge',
		groupKey: endpointId,
		supportsTools: false,
		contextWindow: null,
		promptStyle: null,
		promptHint: null,
	};
}

function makeCustom(overrides: Partial<CustomModel> = {}): CustomModel {
	return {
		id: overrides.id ?? 'cm-1',
		name: overrides.name ?? 'My preset',
		description: null,
		baseEndpointId: overrides.baseEndpointId ?? 'bridge',
		baseModelId: overrides.baseModelId ?? 'gpt-4o',
		systemPrompt: null,
		parameters: null,
		defaultDisabledFeatures: overrides.defaultDisabledFeatures ?? [],
		createdAt: 0,
		updatedAt: 0,
	};
}

const MODELS: ModelEntry[] = [
	makeModel({ id: 'bridge::gpt-4o', upstreamId: 'gpt-4o', kind: 'chat' }),
	makeModel({ id: 'bridge::flux', upstreamId: 'flux', kind: 'image' }),
	makeModel({ id: 'bridge::embed', upstreamId: 'embed', kind: 'embedding' }),
];

/** Mirrors what the (app) layout load ships: built-ins + a connected MCP server. */
const FEATURE_CATEGORIES: FeatureCategoryEntry[] = [
	{ id: 'web', label: 'Web access', description: '', source: 'builtin' },
	{ id: 'personalization', label: 'Personalization', description: '', source: 'builtin' },
	{
		id: 'image_prompt_enhancement',
		label: 'Image prompt enhancement',
		description: '',
		source: 'builtin',
	},
	{
		id: 'video_prompt_enhancement',
		label: 'Video prompt enhancement',
		description: '',
		source: 'builtin',
	},
	{ id: 'mcp:filesystem', label: 'Filesystem', description: '', source: 'mcp' },
];

function renderPage(customModels: CustomModel[] = []) {
	return render(CustomModelsPage, {
		props: {
			data: {
				customModels,
				models: MODELS,
				modelsError: null,
				featureCategories: FEATURE_CATEGORIES,
			},
		},
	});
}

/** The default-features rows are the only "… on by default" checkboxes on the page. */
function featureRowLabels(): string[] {
	return screen
		.getAllByRole('checkbox')
		.map(
			(el) =>
				el
					.closest('label')
					?.textContent?.replace(/\s+on by default\s*$/, '')
					.trim() ?? '',
		)
		.filter(Boolean);
}

beforeEach(() => {
	globalThis.fetch = vi.fn() as unknown as typeof fetch;
});

describe('custom models — default feature toggles', () => {
	it('shows every category before a base model is picked', () => {
		renderPage();
		expect(featureRowLabels()).toEqual([
			'Web access',
			'Personalization',
			'Image prompt enhancement',
			'Video prompt enhancement',
			'Filesystem',
		]);
	});

	it('offers only the image enhancer for an image-model preset', async () => {
		const user = userEvent.setup();
		renderPage([makeCustom({ name: 'Poster maker', baseModelId: 'flux' })]);

		await user.click(screen.getByText('Poster maker'));

		expect(featureRowLabels()).toEqual(['Image prompt enhancement']);
	});

	it('drops both enhancers for a chat-model preset', async () => {
		const user = userEvent.setup();
		renderPage([makeCustom({ name: 'Code review', baseModelId: 'gpt-4o' })]);

		await user.click(screen.getByText('Code review'));

		expect(featureRowLabels()).toEqual(['Web access', 'Personalization', 'Filesystem']);
	});

	it('hides the whole section for an embedding-model preset', async () => {
		const user = userEvent.setup();
		renderPage([makeCustom({ name: 'Embedder', baseModelId: 'embed' })]);

		await user.click(screen.getByText('Embedder'));

		expect(screen.queryByText('Default feature toggles (optional)')).not.toBeInTheDocument();
	});
});
