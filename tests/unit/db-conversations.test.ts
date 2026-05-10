import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDb, closeTestDb, type TestDB } from './_helpers/test-db';
import { seedUser } from './_helpers/seed';

const mocks = vi.hoisted(() => ({ testDb: null as unknown as TestDB }));
vi.mock('$lib/server/db/client', () => ({
	getDb: () => mocks.testDb,
	closeDb: () => {}
}));

import {
	createConversation,
	deleteConversation,
	getConversationDetail,
	getConversationMeta,
	listConversations
} from '$lib/server/db/queries/conversations';
import {
	appendMessage,
	truncateAtMessage,
	walkActiveBranch
} from '$lib/server/db/queries/messages';

beforeEach(() => {
	mocks.testDb = createTestDb();
});

afterEach(() => {
	closeTestDb();
});

describe('conversations CRUD', () => {
	it('creates a conversation with default null leaf and parameters', () => {
		const u = seedUser();
		const conv = createConversation({
			userId: u.id,
			endpointId: 'bridge',
			modelId: 'bridge::gpt-4o',
			modelKind: 'chat'
		});
		expect(conv.id).toBeTruthy();
		expect(conv.activeLeafMessageId).toBeNull();
		expect(conv.parameters).toBeNull();
		expect(conv.systemPrompt).toBeNull();
		expect(conv.messages).toEqual([]);
	});

	it('persists materialized system prompt + parameters from a custom-model snapshot', () => {
		const u = seedUser();
		const conv = createConversation({
			userId: u.id,
			endpointId: 'bridge',
			modelId: 'bridge::gpt-4o',
			modelKind: 'chat',
			systemPrompt: 'Be concise',
			parameters: { temperature: 0.7, max_tokens: 500 },
			customModelId: null
		});
		const detail = getConversationDetail(conv.id, u.id);
		expect(detail?.systemPrompt).toBe('Be concise');
		expect(detail?.parameters).toEqual({ temperature: 0.7, max_tokens: 500 });
	});

	it('listConversations returns newest-first', async () => {
		const u = seedUser();
		const a = createConversation({
			userId: u.id,
			endpointId: 'bridge',
			modelId: 'bridge::a',
			modelKind: 'chat',
			title: 'A'
		});
		// Bump the second one's updatedAt so order is deterministic.
		await new Promise((r) => setTimeout(r, 5));
		const b = createConversation({
			userId: u.id,
			endpointId: 'bridge',
			modelId: 'bridge::b',
			modelKind: 'chat',
			title: 'B'
		});
		const list = listConversations(u.id);
		expect(list.map((c) => c.id)).toEqual([b.id, a.id]);
	});

	it('listConversations is scoped to userId', () => {
		const u1 = seedUser();
		const u2 = seedUser();
		createConversation({
			userId: u1.id,
			endpointId: 'bridge',
			modelId: 'bridge::x',
			modelKind: 'chat'
		});
		expect(listConversations(u1.id)).toHaveLength(1);
		expect(listConversations(u2.id)).toHaveLength(0);
	});

	it('getConversationDetail returns null on cross-user lookup', () => {
		const u1 = seedUser();
		const u2 = seedUser();
		const conv = createConversation({
			userId: u1.id,
			endpointId: 'bridge',
			modelId: 'bridge::x',
			modelKind: 'chat'
		});
		expect(getConversationDetail(conv.id, u2.id)).toBeNull();
	});

	it('deleteConversation cascades messages', () => {
		const u = seedUser();
		const conv = createConversation({
			userId: u.id,
			endpointId: 'bridge',
			modelId: 'bridge::x',
			modelKind: 'chat'
		});
		appendMessage({
			conversationId: conv.id,
			parentMessageId: null,
			role: 'user',
			parts: [{ type: 'text', text: 'hi' }]
		});
		expect(deleteConversation(conv.id, u.id)).toBe(true);
		expect(getConversationDetail(conv.id, u.id)).toBeNull();
	});

	it('deleteConversation refuses cross-user delete', () => {
		const u1 = seedUser();
		const u2 = seedUser();
		const conv = createConversation({
			userId: u1.id,
			endpointId: 'bridge',
			modelId: 'bridge::x',
			modelKind: 'chat'
		});
		expect(deleteConversation(conv.id, u2.id)).toBe(false);
		// And the conversation should still exist for the real owner.
		expect(getConversationDetail(conv.id, u1.id)).not.toBeNull();
	});

	it('getConversationMeta returns the parameters snapshot', () => {
		const u = seedUser();
		const conv = createConversation({
			userId: u.id,
			endpointId: 'bridge',
			modelId: 'bridge::x',
			modelKind: 'chat',
			parameters: { temperature: 0.5 }
		});
		const meta = getConversationMeta(conv.id, u.id);
		expect(meta?.parameters).toEqual({ temperature: 0.5 });
	});
});

describe('messages: append + active-branch walk', () => {
	function setup() {
		const u = seedUser();
		const conv = createConversation({
			userId: u.id,
			endpointId: 'bridge',
			modelId: 'bridge::x',
			modelKind: 'chat'
		});
		return { u, conv };
	}

	it('append updates activeLeafMessageId', () => {
		const { u, conv } = setup();
		const m = appendMessage({
			conversationId: conv.id,
			parentMessageId: null,
			role: 'user',
			parts: [{ type: 'text', text: 'hello' }]
		});
		const detail = getConversationDetail(conv.id, u.id);
		expect(detail?.activeLeafMessageId).toBe(m.id);
		expect(detail?.messages).toHaveLength(1);
		expect(detail?.messages[0].id).toBe(m.id);
	});

	it('walkActiveBranch returns root → leaf in order', () => {
		const { conv } = setup();
		const m1 = appendMessage({
			conversationId: conv.id,
			parentMessageId: null,
			role: 'user',
			parts: [{ type: 'text', text: 'first' }]
		});
		const m2 = appendMessage({
			conversationId: conv.id,
			parentMessageId: m1.id,
			role: 'assistant',
			parts: [{ type: 'text', text: 'reply' }]
		});
		const m3 = appendMessage({
			conversationId: conv.id,
			parentMessageId: m2.id,
			role: 'user',
			parts: [{ type: 'text', text: 'follow-up' }]
		});
		const branch = walkActiveBranch(conv.id);
		expect(branch.map((m) => m.id)).toEqual([m1.id, m2.id, m3.id]);
	});

	it('truncateAtMessage moves activeLeaf to the parent + orphans descendants', () => {
		const { u, conv } = setup();
		const m1 = appendMessage({
			conversationId: conv.id,
			parentMessageId: null,
			role: 'user',
			parts: [{ type: 'text', text: 'first' }]
		});
		const m2 = appendMessage({
			conversationId: conv.id,
			parentMessageId: m1.id,
			role: 'assistant',
			parts: [{ type: 'text', text: 'reply' }]
		});

		const r = truncateAtMessage(conv.id, m2.id);
		expect(r?.newActiveLeaf).toBe(m1.id);

		const detail = getConversationDetail(conv.id, u.id);
		// Active branch is now just [m1] — m2 is orphaned but still in the DB
		// (will become a sibling once the v2 branching UI lands).
		expect(detail?.messages.map((m) => m.id)).toEqual([m1.id]);
	});

	it('truncateAtMessage returns null on cross-conversation message id', () => {
		const { conv } = setup();
		const other = createConversation({
			userId: seedUser().id,
			endpointId: 'bridge',
			modelId: 'bridge::x',
			modelKind: 'chat'
		});
		const otherMsg = appendMessage({
			conversationId: other.id,
			parentMessageId: null,
			role: 'user',
			parts: [{ type: 'text', text: 'x' }]
		});
		expect(truncateAtMessage(conv.id, otherMsg.id)).toBeNull();
	});
});
