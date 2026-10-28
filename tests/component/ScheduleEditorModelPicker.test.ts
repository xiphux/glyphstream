/**
 * The schedule editor picks its model with the chat composer's ModelPicker
 * (grouped by provider, searchable) rather than a flat <select>. These pin
 * the translation between the picker's value shape (`custom::{id}` for a
 * preset) and the schedules API's `customModelId` / `modelId` fields, in both
 * directions.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import ScheduleEditor from '#lib/components/settings/ScheduleEditor.svelte';
import type { CustomModelSummary, ModelEntry, ModelKind, ScheduledTask } from '#lib/types/api.js';

function makeModel(endpointId: string, upstreamId: string, kind: ModelKind = 'chat'): ModelEntry {
	return {
		id: `${endpointId}::${upstreamId}`,
		endpointId,
		upstreamId,
		displayName: upstreamId,
		ownedBy: null,
		kind,
		kindKnown: true,
		group: endpointId,
		groupKey: endpointId,
		supportsTools: true,
		contextWindow: null,
		promptStyle: null,
		promptHint: null,
	};
}

function makePreset(
	id: string,
	name: string,
	baseModelId: string,
	baseEndpointId = 'bridge',
): CustomModelSummary {
	return {
		id,
		name,
		description: null,
		baseEndpointId,
		baseModelId,
		parameters: null,
		defaultDisabledFeatures: [],
		replyStyle: 'standard',
		checkIns: false,
		photos: false,
		avatarMediaId: null,
		createdAt: 0,
		updatedAt: 0,
	};
}

// Every kind, as the page load ships them; the picker offers only chat.
const MODELS = [
	makeModel('bridge', 'gpt-4o'),
	makeModel('bridge', 'flux', 'image'),
	makeModel('cloud', 'big-model'),
];
const PRESETS = [
	makePreset('cm-chat', 'Brief writer', 'gpt-4o'),
	// Built on an image model.
	makePreset('cm-image', 'Poster maker', 'flux'),
	// On an endpoint that's down, so its base model isn't listed either.
	makePreset('cm-offline', 'Offline helper', 'local-llm', 'offline'),
];

function seed(overrides: Partial<ScheduledTask>): ScheduledTask {
	return {
		id: 'sch-1',
		name: 'Morning brief',
		prompt: 'Summarize my inbox',
		modelId: 'bridge::gpt-4o',
		customModelId: null,
		systemPrompt: null,
		parameters: null,
		cadence: { kind: 'daily', time: '07:00', days: [1, 2, 3, 4, 5] },
		timezone: 'UTC',
		toolPolicy: { allowed: [], ask: [], memoryWrites: false },
		disabledFeatures: [],
		deadlineMinutes: 60,
		enabled: true,
		nextRunAt: null,
		consecutiveFailures: 0,
		disabledReason: null,
		createdAt: 0,
		updatedAt: 0,
		...overrides,
	};
}

function renderEditor(initial: ScheduledTask | null = null, unlistedEndpoints: string[] = []) {
	const onSaved = vi.fn();
	render(ScheduleEditor, {
		props: {
			initial,
			models: MODELS,
			customModels: PRESETS,
			favoriteModels: [],
			unlistedEndpoints,
			servers: [],
			defaultTimezone: 'UTC',
			defaultDeadlineMinutes: 60,
			minIntervalHours: 1,
			onSaved,
			onCancel: vi.fn(),
		},
	});
	return { onSaved };
}

function stubFetch() {
	const fetchMock = vi.fn(
		async (_url: string, _init: RequestInit) => new Response('{}', { status: 200 }),
	);
	vi.stubGlobal('fetch', fetchMock);
	return () => JSON.parse(fetchMock.mock.calls[0]![1].body as string) as Record<string, unknown>;
}

async function fillRequired(user: ReturnType<typeof userEvent.setup>) {
	await user.type(screen.getByPlaceholderText('Morning brief'), 'Daily');
	await user.type(screen.getByPlaceholderText(/Search my inbox/), 'Do the thing');
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('ScheduleEditor model picker', () => {
	it('starts with no model chosen, and Create waits for one', async () => {
		const user = userEvent.setup();
		renderEditor();
		await fillRequired(user);
		expect(screen.getByLabelText('Select model')).toHaveTextContent(/Choose a model/);
		expect(screen.getByRole('button', { name: 'Create schedule' })).toBeDisabled();
	});

	it('saves a picked base model as modelId', async () => {
		const user = userEvent.setup();
		const body = stubFetch();
		renderEditor();
		await fillRequired(user);
		await user.click(screen.getByLabelText('Select model'));
		await user.click(screen.getByRole('option', { name: /big-model/ }));
		await user.click(screen.getByRole('button', { name: 'Create schedule' }));
		expect(body()).toMatchObject({ modelId: 'cloud::big-model' });
		expect(body()).not.toHaveProperty('customModelId');
	});

	it('saves a picked preset as customModelId', async () => {
		const user = userEvent.setup();
		const body = stubFetch();
		renderEditor();
		await fillRequired(user);
		await user.click(screen.getByLabelText('Select model'));
		await user.click(screen.getByRole('option', { name: /Brief writer/ }));
		expect(screen.getByText(/prompt and settings are copied in/)).toBeInTheDocument();
		await user.click(screen.getByRole('button', { name: 'Create schedule' }));
		expect(body()).toMatchObject({ customModelId: 'cm-chat' });
		expect(body()).not.toHaveProperty('modelId');
	});

	it('keeps a preset whose endpoint could not list its models', async () => {
		const user = userEvent.setup();
		const body = stubFetch();
		renderEditor(seed({ customModelId: 'cm-offline' }), ['offline']);
		expect(screen.getByLabelText('Select model')).toHaveTextContent('Offline helper');
		await user.click(screen.getByLabelText('Select model'));
		expect(screen.getByRole('option', { name: /Offline helper/ })).toBeInTheDocument();
		await user.keyboard('{Escape}');
		await user.click(screen.getByRole('button', { name: 'Save changes' }));
		expect(body()).toMatchObject({ customModelId: 'cm-offline' });
	});

	it.each([
		['its endpoint listed fine', []],
		// The listing failed, but an earlier one's models are still known.
		['its endpoint is failing on a cached list', ['bridge']],
	])("doesn't offer a preset built on a model a run can't use when %s", async (_, unlisted) => {
		const user = userEvent.setup();
		renderEditor(null, unlisted);
		await user.click(screen.getByLabelText('Select model'));
		expect(screen.getByRole('option', { name: /Brief writer/ })).toBeInTheDocument();
		expect(screen.queryByRole('option', { name: /Poster maker/ })).toBeNull();
		expect(screen.queryByRole('option', { name: /^flux/ })).toBeNull();
	});

	it("shows an existing schedule's preset, and keeps it on save", async () => {
		const user = userEvent.setup();
		const body = stubFetch();
		renderEditor(seed({ customModelId: 'cm-chat' }));
		expect(screen.getByLabelText('Select model')).toHaveTextContent('Brief writer');
		await user.click(screen.getByRole('button', { name: 'Save changes' }));
		expect(body()).toMatchObject({ customModelId: 'cm-chat' });
	});

	it("shows an existing schedule's base model", () => {
		renderEditor(seed({ modelId: 'cloud::big-model' }));
		expect(screen.getByLabelText('Select model')).toHaveTextContent('big-model');
	});
});
