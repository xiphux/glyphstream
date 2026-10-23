/**
 * What the `(app)` layout ships to every page. It reloads on every completed
 * turn and every return to the app, so a field here is paid for again each
 * time: presets go without their system prompts (`CustomModelSummary`) and
 * preferences without their free-text fields (`LayoutPreferences`). The pages
 * that edit those load them themselves.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDb, closeTestDb } from './_helpers/test-db';
import { seedUser } from './_helpers/seed';

vi.mock('#lib/server/endpoints/list-models.js', async (importOriginal) => ({
	...(await importOriginal<typeof import('#lib/server/endpoints/list-models.js')>()),
	listAllModels: () => Promise.resolve([]),
}));
vi.mock('#lib/server/mcp/bootstrap.js', async (importOriginal) => ({
	...(await importOriginal<typeof import('#lib/server/mcp/bootstrap.js')>()),
	isMcpReady: () => true,
}));

import { load as layoutLoad } from '../../src/routes/(app)/+layout.server';
import { load as preferencesLoad } from '../../src/routes/(app)/settings/preferences/+page.server';
import { createCustomModel } from '#lib/server/db/queries/custom-models.js';
import { setUserPreferences } from '#lib/server/db/queries/user-preferences.js';

let user: ReturnType<typeof seedUser>;

beforeEach(() => {
	createTestDb();
	user = seedUser();
	createCustomModel({
		userId: user.id,
		name: 'Narrator',
		description: null,
		baseEndpointId: 'ep',
		baseModelId: 'm',
		systemPrompt: 'A long character card. '.repeat(200),
		parameters: null,
	});
	setUserPreferences(user.id, { aboutYou: 'Standing context', customInstructions: 'Be terse' });
});
afterEach(() => closeTestDb());

function runLayout() {
	return layoutLoad({
		locals: { user },
		url: new URL('http://x/'),
		depends: () => {},
		isDataRequest: true,
	} as unknown as Parameters<typeof layoutLoad>[0]) as Promise<Record<string, unknown>>;
}

describe('the (app) layout payload', () => {
	it('ships presets without their system prompts', async () => {
		const data = await runLayout();
		const presets = data.customModels as Array<Record<string, unknown>>;
		expect(presets).toHaveLength(1);
		expect(presets[0]).toMatchObject({ name: 'Narrator', baseModelId: 'm' });
		expect(presets[0]).not.toHaveProperty('systemPrompt');
	});

	it('ships preferences without the free-text fields', async () => {
		const prefs = (await runLayout()).prefs as Record<string, unknown>;
		expect(prefs).toHaveProperty('enterBehavior');
		expect(prefs).not.toHaveProperty('aboutYou');
		expect(prefs).not.toHaveProperty('customInstructions');
	});

	it('leaves the preferences page to load them itself', async () => {
		const layout = await runLayout();
		const data = (await preferencesLoad({
			locals: { user },
			parent: () => Promise.resolve(layout),
		} as unknown as Parameters<typeof preferencesLoad>[0])) as {
			prefs: { aboutYou: string; customInstructions: string };
		};
		expect(data.prefs).toMatchObject({
			aboutYou: 'Standing context',
			customInstructions: 'Be terse',
		});
	});
});
