import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDb, closeTestDb, type TestDB } from './_helpers/test-db';
import { seedUser } from './_helpers/seed';

const mocks = vi.hoisted(() => ({ testDb: null as unknown as TestDB }));
vi.mock('$lib/server/db/client', () => ({
	getDb: () => mocks.testDb,
	closeDb: () => {},
}));

import {
	createCustomModel,
	deleteCustomModel,
	getCustomModelForUser,
	listCustomModelsForUser,
	updateCustomModel,
} from '$lib/server/db/queries/custom-models';
import { createConversation, getConversationDetail } from '$lib/server/db/queries/conversations';

beforeEach(() => {
	mocks.testDb = createTestDb();
});

afterEach(() => {
	closeTestDb();
});

describe('custom-models CRUD', () => {
	it('createCustomModel persists + returns the row', () => {
		const u = seedUser();
		const cm = createCustomModel({
			userId: u.id,
			name: 'Coding Bot',
			description: 'For code',
			baseEndpointId: 'bridge',
			baseModelId: 'gpt-4o',
			systemPrompt: 'Be terse',
			parameters: { temperature: 0.3 },
		});
		expect(cm.id).toBeTruthy();
		expect(cm.name).toBe('Coding Bot');
		expect(cm.parameters).toEqual({ temperature: 0.3 });
	});

	it('getCustomModelForUser returns null on cross-user access', () => {
		const u1 = seedUser();
		const u2 = seedUser();
		const cm = createCustomModel({
			userId: u1.id,
			name: 'X',
			description: null,
			baseEndpointId: 'bridge',
			baseModelId: 'gpt-4o',
			systemPrompt: null,
			parameters: null,
		});
		expect(getCustomModelForUser(cm.id, u1.id)?.name).toBe('X');
		expect(getCustomModelForUser(cm.id, u2.id)).toBeNull();
	});

	it('listCustomModelsForUser is alphabetical + scoped', () => {
		const u = seedUser();
		const u2 = seedUser();
		createCustomModel({
			userId: u.id,
			name: 'Bravo',
			description: null,
			baseEndpointId: 'bridge',
			baseModelId: 'x',
			systemPrompt: null,
			parameters: null,
		});
		createCustomModel({
			userId: u.id,
			name: 'Alpha',
			description: null,
			baseEndpointId: 'bridge',
			baseModelId: 'x',
			systemPrompt: null,
			parameters: null,
		});
		createCustomModel({
			userId: u2.id,
			name: 'OtherUser',
			description: null,
			baseEndpointId: 'bridge',
			baseModelId: 'x',
			systemPrompt: null,
			parameters: null,
		});
		const list = listCustomModelsForUser(u.id);
		expect(list.map((c) => c.name)).toEqual(['Alpha', 'Bravo']);
	});

	it('updateCustomModel patches only supplied fields, returns updated row', () => {
		const u = seedUser();
		const cm = createCustomModel({
			userId: u.id,
			name: 'Original',
			description: 'orig desc',
			baseEndpointId: 'bridge',
			baseModelId: 'gpt-4o',
			systemPrompt: 'orig prompt',
			parameters: { temperature: 0.5 },
		});
		const updated = updateCustomModel(cm.id, u.id, {
			name: 'Renamed',
			parameters: { temperature: 0.9 },
		});
		expect(updated?.name).toBe('Renamed');
		expect(updated?.description).toBe('orig desc'); // unchanged
		expect(updated?.systemPrompt).toBe('orig prompt'); // unchanged
		expect(updated?.parameters).toEqual({ temperature: 0.9 });
	});

	it('updateCustomModel can clear an optional field by passing null', () => {
		const u = seedUser();
		const cm = createCustomModel({
			userId: u.id,
			name: 'X',
			description: 'remove me',
			baseEndpointId: 'bridge',
			baseModelId: 'gpt-4o',
			systemPrompt: 'remove me too',
			parameters: { temperature: 0.5 },
		});
		const updated = updateCustomModel(cm.id, u.id, {
			description: null,
			parameters: null,
		});
		expect(updated?.description).toBeNull();
		expect(updated?.parameters).toBeNull();
	});

	it('updateCustomModel returns null on cross-user attempt', () => {
		const u1 = seedUser();
		const u2 = seedUser();
		const cm = createCustomModel({
			userId: u1.id,
			name: 'X',
			description: null,
			baseEndpointId: 'bridge',
			baseModelId: 'x',
			systemPrompt: null,
			parameters: null,
		});
		expect(updateCustomModel(cm.id, u2.id, { name: 'hijack' })).toBeNull();
		// Original is untouched.
		expect(getCustomModelForUser(cm.id, u1.id)?.name).toBe('X');
	});

	it('deleteCustomModel returns true + cleans up', () => {
		const u = seedUser();
		const cm = createCustomModel({
			userId: u.id,
			name: 'X',
			description: null,
			baseEndpointId: 'bridge',
			baseModelId: 'x',
			systemPrompt: null,
			parameters: null,
		});
		expect(deleteCustomModel(cm.id, u.id)).toBe(true);
		expect(getCustomModelForUser(cm.id, u.id)).toBeNull();
	});

	it('deleteCustomModel sets conversations.customModelId to null (FK ON DELETE SET NULL)', () => {
		const u = seedUser();
		const cm = createCustomModel({
			userId: u.id,
			name: 'X',
			description: null,
			baseEndpointId: 'bridge',
			baseModelId: 'gpt-4o',
			systemPrompt: 'stay',
			parameters: null,
		});
		const conv = createConversation({
			userId: u.id,
			endpointId: 'bridge',
			modelId: 'bridge::gpt-4o',
			modelKind: 'chat',
			customModelId: cm.id,
			systemPrompt: 'stay',
		});
		deleteCustomModel(cm.id, u.id);

		// Conversation survives — historical chats keep working — but
		// loses the back-link to the (now-gone) preset.
		const detail = getConversationDetail(conv.id, u.id);
		expect(detail).not.toBeNull();
		expect(detail?.customModelId).toBeNull();
		// Snapshot of the system prompt is preserved on the conversation
		// even though the preset that supplied it is gone.
		expect(detail?.systemPrompt).toBe('stay');
	});

	it('deleteCustomModel returns false on cross-user attempt', () => {
		const u1 = seedUser();
		const u2 = seedUser();
		const cm = createCustomModel({
			userId: u1.id,
			name: 'X',
			description: null,
			baseEndpointId: 'bridge',
			baseModelId: 'x',
			systemPrompt: null,
			parameters: null,
		});
		expect(deleteCustomModel(cm.id, u2.id)).toBe(false);
	});

	it('defaultDisabledFeatures defaults to [] when omitted from create', () => {
		const u = seedUser();
		const cm = createCustomModel({
			userId: u.id,
			name: 'Default',
			description: null,
			baseEndpointId: 'bridge',
			baseModelId: 'x',
			systemPrompt: null,
			parameters: null,
		});
		expect(cm.defaultDisabledFeatures).toEqual([]);
		// Round-trip through the DB — the read-back should match.
		expect(getCustomModelForUser(cm.id, u.id)?.defaultDisabledFeatures).toEqual([]);
	});

	it('createCustomModel persists explicit defaultDisabledFeatures', () => {
		const u = seedUser();
		const cm = createCustomModel({
			userId: u.id,
			name: 'No-personalization preset',
			description: null,
			baseEndpointId: 'bridge',
			baseModelId: 'x',
			systemPrompt: null,
			parameters: null,
			defaultDisabledFeatures: ['personalization'],
		});
		expect(cm.defaultDisabledFeatures).toEqual(['personalization']);
		expect(getCustomModelForUser(cm.id, u.id)?.defaultDisabledFeatures).toEqual([
			'personalization',
		]);
	});

	it('updateCustomModel patches defaultDisabledFeatures + can clear via []', () => {
		const u = seedUser();
		const cm = createCustomModel({
			userId: u.id,
			name: 'X',
			description: null,
			baseEndpointId: 'bridge',
			baseModelId: 'x',
			systemPrompt: null,
			parameters: null,
			defaultDisabledFeatures: ['personalization'],
		});
		// Change to a different category.
		const updated = updateCustomModel(cm.id, u.id, {
			defaultDisabledFeatures: ['web'],
		});
		expect(updated?.defaultDisabledFeatures).toEqual(['web']);
		// Clear back to the global default.
		const cleared = updateCustomModel(cm.id, u.id, {
			defaultDisabledFeatures: [],
		});
		expect(cleared?.defaultDisabledFeatures).toEqual([]);
	});

	it('updateCustomModel leaves defaultDisabledFeatures alone when not in the patch', () => {
		const u = seedUser();
		const cm = createCustomModel({
			userId: u.id,
			name: 'X',
			description: null,
			baseEndpointId: 'bridge',
			baseModelId: 'x',
			systemPrompt: null,
			parameters: null,
			defaultDisabledFeatures: ['personalization'],
		});
		// Patch only the name — feature defaults should be preserved, not
		// implicitly reset to [].
		const updated = updateCustomModel(cm.id, u.id, { name: 'Renamed' });
		expect(updated?.defaultDisabledFeatures).toEqual(['personalization']);
	});
});
