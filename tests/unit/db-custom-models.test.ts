import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb, closeTestDb } from './_helpers/test-db';
import { seedUser } from './_helpers/seed';

import {
	createCustomModel,
	deleteCustomModel,
	getCustomModelForUser,
	listCustomModelsForUser,
	updateCustomModel,
} from '#lib/server/db/queries/custom-models.js';
import { createConversation, getConversationDetail } from '#lib/server/db/queries/conversations.js';

beforeEach(() => {
	createTestDb();
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
	it('replyStyle defaults to standard, persists, and patches', () => {
		const u = seedUser();
		const base = {
			userId: u.id,
			description: null,
			baseEndpointId: 'bridge',
			baseModelId: 'x',
			systemPrompt: null,
			parameters: null,
		};
		expect(createCustomModel({ ...base, name: 'A' }).replyStyle).toBe('standard');
		const cm = createCustomModel({ ...base, name: 'B', replyStyle: 'texting' });
		expect(getCustomModelForUser(cm.id, u.id)?.replyStyle).toBe('texting');
		expect(updateCustomModel(cm.id, u.id, { name: 'C' })?.replyStyle).toBe('texting');
		expect(updateCustomModel(cm.id, u.id, { replyStyle: 'standard' })?.replyStyle).toBe('standard');
	});

	it('checkIns defaults off, persists, and patches', () => {
		const u = seedUser();
		const base = {
			userId: u.id,
			description: null,
			baseEndpointId: 'bridge',
			baseModelId: 'x',
			systemPrompt: null,
			parameters: null,
		};
		expect(createCustomModel({ ...base, name: 'A' }).checkIns).toBe(false);
		const cm = createCustomModel({ ...base, name: 'B', checkIns: true });
		expect(getCustomModelForUser(cm.id, u.id)?.checkIns).toBe(true);
		expect(updateCustomModel(cm.id, u.id, { checkIns: false })?.checkIns).toBe(false);
	});

	it('a conversation keeps the checkIns it was created with', () => {
		const u = seedUser();
		const conv = createConversation({
			userId: u.id,
			endpointId: 'bridge',
			modelId: 'bridge::x',
			modelKind: 'chat',
			checkIns: true,
		});
		expect(getConversationDetail(conv.id, u.id)?.checkIns).toBe(true);
		const plain = createConversation({
			userId: u.id,
			endpointId: 'bridge',
			modelId: 'bridge::x',
			modelKind: 'chat',
		});
		expect(getConversationDetail(plain.id, u.id)?.checkIns).toBe(false);
	});

	it('photos defaults off, persists, and patches — and a conversation keeps it', () => {
		const u = seedUser();
		const base = {
			userId: u.id,
			description: null,
			baseEndpointId: 'bridge',
			baseModelId: 'x',
			systemPrompt: null,
			parameters: null,
		};
		expect(createCustomModel({ ...base, name: 'A' }).photos).toBe(false);
		const cm = createCustomModel({ ...base, name: 'B', photos: true });
		expect(getCustomModelForUser(cm.id, u.id)?.photos).toBe(true);
		expect(updateCustomModel(cm.id, u.id, { photos: false })?.photos).toBe(false);
		const conv = createConversation({
			userId: u.id,
			endpointId: 'bridge',
			modelId: 'bridge::x',
			modelKind: 'chat',
			photos: true,
		});
		expect(getConversationDetail(conv.id, u.id)?.photos).toBe(true);
	});

	it('a conversation keeps the replyStyle it was created with', () => {
		const u = seedUser();
		const conv = createConversation({
			userId: u.id,
			endpointId: 'bridge',
			modelId: 'bridge::x',
			modelKind: 'chat',
			replyStyle: 'texting',
		});
		expect(conv.replyStyle).toBe('texting');
		expect(getConversationDetail(conv.id, u.id)?.replyStyle).toBe('texting');
		const plain = createConversation({
			userId: u.id,
			endpointId: 'bridge',
			modelId: 'bridge::x',
			modelKind: 'chat',
		});
		expect(getConversationDetail(plain.id, u.id)?.replyStyle).toBe('standard');
	});
});
