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
import { fireEvent, render, screen } from '@testing-library/svelte';
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
		avatarMediaId: overrides.avatarMediaId ?? null,
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
	globalThis.fetch = vi.fn();
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

/**
 * Avatar editing. The contract worth pinning is that avatar changes are
 * STAGED: nothing about a picked file reaches the network until Save, and Save
 * sends the preset, the upload, and the link in that order — the link needs
 * both the preset's id (which on create doesn't exist until the POST answers)
 * and the upload's media id.
 */
describe('custom models — avatar', () => {
	interface Call {
		url: string;
		method: string;
		body: unknown;
	}

	/** Records every request and answers each endpoint with its real shape. */
	function stubFetch(): Call[] {
		const calls: Call[] = [];
		globalThis.fetch = vi.fn((url: string, init?: RequestInit) => {
			const method = init?.method ?? 'GET';
			calls.push({
				url,
				method,
				body: typeof init?.body === 'string' ? JSON.parse(init.body) : (init?.body ?? null),
			});
			// Mirror the real bodies: /api/uploads answers with the new media id,
			// the preset endpoints with the saved row (the create path reads its
			// id back off this).
			const payload =
				url === '/api/uploads' ? { id: 'media-new' } : { customModel: { id: 'cm-1' } };
			return Promise.resolve({
				ok: true,
				status: 200,
				json: () => Promise.resolve(payload),
			});
		}) as unknown as typeof fetch;
		return calls;
	}

	function pickFile(container: HTMLElement, file: File) {
		const input = container.querySelector<HTMLInputElement>('input[type="file"]')!;
		// Set `files` directly rather than userEvent.upload: the input is
		// `class="hidden"` (display:none), which userEvent refuses to click.
		Object.defineProperty(input, 'files', { value: [file], configurable: true });
		return fireEvent.change(input);
	}

	const png = () => new File(['x'], 'face.png', { type: 'image/png' });

	it('shows a saved avatar in the list and loads it into the form', async () => {
		const user = userEvent.setup();
		const { container } = renderPage([makeCustom({ name: 'Ilya', avatarMediaId: 'media-1' })]);

		expect(container.querySelector('img[src="/api/media/media-1/thumbnail"]')).toBeInTheDocument();

		await user.click(screen.getByRole('button', { name: /^Ilya/ }));
		// Two now: the list row and the form preview.
		expect(container.querySelectorAll('img[src="/api/media/media-1/thumbnail"]')).toHaveLength(2);
		expect(screen.getByRole('button', { name: 'Replace' })).toBeInTheDocument();
	});

	it('stages a picked file without sending anything until save', async () => {
		const user = userEvent.setup();
		const calls = stubFetch();
		const { container } = renderPage([makeCustom({ name: 'Ilya' })]);
		await user.click(screen.getByRole('button', { name: /^Ilya/ }));

		await pickFile(container, png());

		expect(calls).toHaveLength(0);
		expect(screen.getByText('Applied when you save')).toBeInTheDocument();
	});

	it('saves the preset, then uploads, then links the returned media id', async () => {
		const user = userEvent.setup();
		const calls = stubFetch();
		const { container } = renderPage([makeCustom({ id: 'cm-1', name: 'Ilya' })]);
		await user.click(screen.getByRole('button', { name: /^Ilya/ }));
		await pickFile(container, png());

		await user.click(screen.getByRole('button', { name: 'Save changes' }));

		expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
			'PATCH /api/custom-models/cm-1',
			'POST /api/uploads',
			'PUT /api/custom-models/cm-1/avatar',
		]);
		expect(calls[2].body).toEqual({ mediaId: 'media-new' });
	});

	it('sends a DELETE when a saved avatar is removed', async () => {
		const user = userEvent.setup();
		const calls = stubFetch();
		renderPage([makeCustom({ id: 'cm-1', name: 'Ilya', avatarMediaId: 'media-1' })]);
		await user.click(screen.getByRole('button', { name: /^Ilya/ }));

		await user.click(screen.getByRole('button', { name: 'Remove' }));
		await user.click(screen.getByRole('button', { name: 'Save changes' }));

		expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
			'PATCH /api/custom-models/cm-1',
			'DELETE /api/custom-models/cm-1/avatar',
		]);
	});

	it('rejects a non-image before it can be staged', async () => {
		const user = userEvent.setup();
		const calls = stubFetch();
		const { container } = renderPage([makeCustom({ name: 'Ilya' })]);
		await user.click(screen.getByRole('button', { name: /^Ilya/ }));

		await pickFile(container, new File(['x'], 'notes.pdf', { type: 'application/pdf' }));

		expect(screen.getByText('An avatar must be an image')).toBeInTheDocument();
		expect(calls).toHaveLength(0);
	});

	it('leaves the avatar alone when nothing was staged', async () => {
		const user = userEvent.setup();
		const calls = stubFetch();
		renderPage([makeCustom({ id: 'cm-1', name: 'Ilya', avatarMediaId: 'media-1' })]);
		await user.click(screen.getByRole('button', { name: /^Ilya/ }));

		await user.click(screen.getByRole('button', { name: 'Save changes' }));

		// No avatar call at all — a plain edit must not disturb the reference.
		expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual(['PATCH /api/custom-models/cm-1']);
	});
});
