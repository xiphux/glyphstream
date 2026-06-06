import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDb, closeTestDb, type TestDB } from './_helpers/test-db';
import { seedUser } from './_helpers/seed';

const mocks = vi.hoisted(() => ({ testDb: null as unknown as TestDB }));
vi.mock('$lib/server/db/client', () => ({
	getDb: () => mocks.testDb,
	closeDb: () => {},
}));

import {
	archiveConversation,
	createConversation,
	deleteConversation,
	getConversationDetail,
	getConversationMeta,
	getFanoutParent,
	listArchivedConversations,
	listConversations,
	setDisabledFeatures,
	setFanoutParent,
	unarchiveConversation,
	updateConversationModel,
} from '$lib/server/db/queries/conversations';
import {
	appendMessage,
	deleteBranch,
	findUserMessageAncestor,
	getMessage,
	getSiblingAssistants,
	resolveParentForUserMessage,
	selectBranch,
	setActiveLeafMessageId,
	truncateAtMessage,
	walkActiveBranch,
} from '$lib/server/db/queries/messages';
import {
	countOrphanMediaInConversation,
	insertMedia,
	linkMessageMedia,
} from '$lib/server/db/queries/media';
import { getFanoutRecoveryState } from '$lib/server/messages/fanout-recovery';
import { registerInFlight, resetInFlight } from '$lib/server/streaming/in-flight';
import type { LoadedEndpoint } from '$lib/server/endpoints/config';
import { media } from '$lib/server/db/schema';
import { eq } from 'drizzle-orm';

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
			modelKind: 'chat',
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
			customModelId: null,
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
			title: 'A',
		});
		// Bump the second one's updatedAt so order is deterministic.
		await new Promise((r) => setTimeout(r, 5));
		const b = createConversation({
			userId: u.id,
			endpointId: 'bridge',
			modelId: 'bridge::b',
			modelKind: 'chat',
			title: 'B',
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
			modelKind: 'chat',
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
			modelKind: 'chat',
		});
		expect(getConversationDetail(conv.id, u2.id)).toBeNull();
	});

	it('deleteConversation cascades messages', () => {
		const u = seedUser();
		const conv = createConversation({
			userId: u.id,
			endpointId: 'bridge',
			modelId: 'bridge::x',
			modelKind: 'chat',
		});
		appendMessage({
			conversationId: conv.id,
			parentMessageId: null,
			role: 'user',
			parts: [{ type: 'text', text: 'hi' }],
		});
		expect(deleteConversation(conv.id, u.id).ok).toBe(true);
		expect(getConversationDetail(conv.id, u.id)).toBeNull();
	});

	it('deleteConversation refuses cross-user delete', () => {
		const u1 = seedUser();
		const u2 = seedUser();
		const conv = createConversation({
			userId: u1.id,
			endpointId: 'bridge',
			modelId: 'bridge::x',
			modelKind: 'chat',
		});
		expect(deleteConversation(conv.id, u2.id).ok).toBe(false);
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
			parameters: { temperature: 0.5 },
		});
		const meta = getConversationMeta(conv.id, u.id);
		expect(meta?.parameters).toEqual({ temperature: 0.5 });
	});
});

describe('per-conversation feature opt-outs', () => {
	it('defaults to empty disabledFeatures on a new conversation', () => {
		const u = seedUser();
		const conv = createConversation({
			userId: u.id,
			endpointId: 'bridge',
			modelId: 'bridge::x',
			modelKind: 'chat',
		});
		expect(conv.disabledFeatures).toEqual([]);
		expect(getConversationMeta(conv.id, u.id)?.disabledFeatures).toEqual([]);
		expect(getConversationDetail(conv.id, u.id)?.disabledFeatures).toEqual([]);
	});

	it('persists initial disabledFeatures supplied at create time', () => {
		const u = seedUser();
		const conv = createConversation({
			userId: u.id,
			endpointId: 'bridge',
			modelId: 'bridge::x',
			modelKind: 'chat',
			disabledFeatures: ['web'],
		});
		expect(conv.disabledFeatures).toEqual(['web']);
		expect(getConversationMeta(conv.id, u.id)?.disabledFeatures).toEqual(['web']);
	});

	it('setDisabledFeatures persists across reads', () => {
		const u = seedUser();
		const conv = createConversation({
			userId: u.id,
			endpointId: 'bridge',
			modelId: 'bridge::x',
			modelKind: 'chat',
		});
		expect(setDisabledFeatures(conv.id, u.id, ['web'])).toBe(true);
		expect(getConversationMeta(conv.id, u.id)?.disabledFeatures).toEqual(['web']);
	});

	it('setDisabledFeatures with [] clears the column (round-trips to empty)', () => {
		const u = seedUser();
		const conv = createConversation({
			userId: u.id,
			endpointId: 'bridge',
			modelId: 'bridge::x',
			modelKind: 'chat',
			disabledFeatures: ['web'],
		});
		expect(setDisabledFeatures(conv.id, u.id, [])).toBe(true);
		expect(getConversationMeta(conv.id, u.id)?.disabledFeatures).toEqual([]);
	});

	it('setDisabledFeatures refuses cross-user updates', () => {
		const u1 = seedUser();
		const u2 = seedUser();
		const conv = createConversation({
			userId: u1.id,
			endpointId: 'bridge',
			modelId: 'bridge::x',
			modelKind: 'chat',
		});
		expect(setDisabledFeatures(conv.id, u2.id, ['web'])).toBe(false);
		expect(getConversationMeta(conv.id, u1.id)?.disabledFeatures).toEqual([]);
	});

	it('setDisabledFeatures does not bump updatedAt (privacy toggle is not a content change)', async () => {
		const u = seedUser();
		const conv = createConversation({
			userId: u.id,
			endpointId: 'bridge',
			modelId: 'bridge::x',
			modelKind: 'chat',
		});
		const beforeTs = getConversationDetail(conv.id, u.id)!.updatedAt;
		await new Promise((r) => setTimeout(r, 3));
		setDisabledFeatures(conv.id, u.id, ['web']);
		expect(getConversationDetail(conv.id, u.id)!.updatedAt).toBe(beforeTs);
	});
});

describe('archiving', () => {
	it('archive removes from active list, surfaces in archived list', () => {
		const u = seedUser();
		const conv = createConversation({
			userId: u.id,
			endpointId: 'bridge',
			modelId: 'bridge::x',
			modelKind: 'chat',
			title: 'A',
		});
		expect(listConversations(u.id)).toHaveLength(1);
		expect(listArchivedConversations(u.id)).toHaveLength(0);

		expect(archiveConversation(conv.id, u.id)).toBe(true);
		expect(listConversations(u.id)).toHaveLength(0);
		expect(listArchivedConversations(u.id).map((c) => c.id)).toEqual([conv.id]);
	});

	it('unarchive restores to active list', () => {
		const u = seedUser();
		const conv = createConversation({
			userId: u.id,
			endpointId: 'bridge',
			modelId: 'bridge::x',
			modelKind: 'chat',
		});
		archiveConversation(conv.id, u.id);
		expect(unarchiveConversation(conv.id, u.id)).toBe(true);
		expect(listConversations(u.id).map((c) => c.id)).toEqual([conv.id]);
		expect(listArchivedConversations(u.id)).toHaveLength(0);
	});

	it('archive preserves updatedAt so archived list sorts by last activity', () => {
		const u = seedUser();
		const conv = createConversation({
			userId: u.id,
			endpointId: 'bridge',
			modelId: 'bridge::x',
			modelKind: 'chat',
		});
		const before = listConversations(u.id)[0];
		archiveConversation(conv.id, u.id);
		const after = listArchivedConversations(u.id)[0];
		expect(after.updatedAt).toBe(before.updatedAt);
	});

	it('archive refuses cross-user, archived stays archived for owner', () => {
		const u1 = seedUser();
		const u2 = seedUser();
		const conv = createConversation({
			userId: u1.id,
			endpointId: 'bridge',
			modelId: 'bridge::x',
			modelKind: 'chat',
		});
		expect(archiveConversation(conv.id, u2.id)).toBe(false);
		expect(listConversations(u1.id)).toHaveLength(1);
	});

	it('unarchive refuses cross-user', () => {
		const u1 = seedUser();
		const u2 = seedUser();
		const conv = createConversation({
			userId: u1.id,
			endpointId: 'bridge',
			modelId: 'bridge::x',
			modelKind: 'chat',
		});
		archiveConversation(conv.id, u1.id);
		expect(unarchiveConversation(conv.id, u2.id)).toBe(false);
		expect(listArchivedConversations(u1.id)).toHaveLength(1);
	});

	it('listArchivedConversations is scoped to userId', () => {
		const u1 = seedUser();
		const u2 = seedUser();
		const conv = createConversation({
			userId: u1.id,
			endpointId: 'bridge',
			modelId: 'bridge::x',
			modelKind: 'chat',
		});
		archiveConversation(conv.id, u1.id);
		expect(listArchivedConversations(u1.id)).toHaveLength(1);
		expect(listArchivedConversations(u2.id)).toHaveLength(0);
	});

	it('archived conversations are still navigable via getConversationDetail', () => {
		const u = seedUser();
		const conv = createConversation({
			userId: u.id,
			endpointId: 'bridge',
			modelId: 'bridge::x',
			modelKind: 'chat',
		});
		archiveConversation(conv.id, u.id);
		expect(getConversationDetail(conv.id, u.id)).not.toBeNull();
	});
});

describe('updateConversationModel', () => {
	function seed(extra?: { systemPrompt?: string }) {
		const u = seedUser();
		const conv = createConversation({
			userId: u.id,
			endpointId: 'bridge',
			modelId: 'bridge::gpt-4o',
			modelKind: 'chat',
			systemPrompt: extra?.systemPrompt,
		});
		return { u, conv };
	}

	it('rewrites endpoint/model/kind in place', () => {
		const { u, conv } = seed();
		const ok = updateConversationModel(conv.id, u.id, {
			endpointId: 'groq',
			modelId: 'groq::llama-3.3-70b',
			modelKind: 'chat',
		});
		expect(ok).toBe(true);
		const meta = getConversationMeta(conv.id, u.id);
		expect(meta?.endpointId).toBe('groq');
		expect(meta?.modelId).toBe('groq::llama-3.3-70b');
		expect(meta?.modelKind).toBe('chat');
	});

	it('preserves system prompt — model switch is not a persona switch', () => {
		const { u, conv } = seed({ systemPrompt: 'You are Bert.' });
		updateConversationModel(conv.id, u.id, {
			endpointId: 'groq',
			modelId: 'groq::llama-3.3-70b',
			modelKind: 'chat',
		});
		expect(getConversationMeta(conv.id, u.id)?.systemPrompt).toBe('You are Bert.');
	});

	it('supports modality switches (chat → image)', () => {
		const { u, conv } = seed();
		updateConversationModel(conv.id, u.id, {
			endpointId: 'bridge',
			modelId: 'bridge::comfyui/sdxl',
			modelKind: 'image',
		});
		expect(getConversationMeta(conv.id, u.id)?.modelKind).toBe('image');
	});

	it('bumps updatedAt so the sidebar resorts the conversation to the top', async () => {
		const { u, conv } = seed();
		const before = getConversationMeta(conv.id, u.id);
		// `updatedAt` only has ms precision; sleep so the next stamp differs.
		await new Promise((r) => setTimeout(r, 2));
		updateConversationModel(conv.id, u.id, {
			endpointId: 'bridge',
			modelId: 'bridge::other',
			modelKind: 'chat',
		});
		// listConversations returns updatedAt; verify it advanced.
		const list = listConversations(u.id);
		const after = list.find((c) => c.id === conv.id);
		expect(after).toBeDefined();
		expect(after!.updatedAt).toBeGreaterThan(before ? 0 : -1);
		// And the row should still be there & owned.
		expect(after!.id).toBe(conv.id);
	});

	it('returns false for a foreign user (ownership filter)', () => {
		const { conv } = seed();
		const intruder = seedUser();
		const ok = updateConversationModel(conv.id, intruder.id, {
			endpointId: 'groq',
			modelId: 'groq::llama-3.3-70b',
			modelKind: 'chat',
		});
		expect(ok).toBe(false);
	});

	it('returns false for a nonexistent conversation id', () => {
		const u = seedUser();
		const ok = updateConversationModel('does-not-exist', u.id, {
			endpointId: 'groq',
			modelId: 'groq::llama-3.3-70b',
			modelKind: 'chat',
		});
		expect(ok).toBe(false);
	});
});

describe('messages: append + active-branch walk', () => {
	function setup() {
		const u = seedUser();
		const conv = createConversation({
			userId: u.id,
			endpointId: 'bridge',
			modelId: 'bridge::x',
			modelKind: 'chat',
		});
		return { u, conv };
	}

	it('append updates activeLeafMessageId', () => {
		const { u, conv } = setup();
		const m = appendMessage({
			conversationId: conv.id,
			parentMessageId: null,
			role: 'user',
			parts: [{ type: 'text', text: 'hello' }],
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
			parts: [{ type: 'text', text: 'first' }],
		});
		const m2 = appendMessage({
			conversationId: conv.id,
			parentMessageId: m1.id,
			role: 'assistant',
			parts: [{ type: 'text', text: 'reply' }],
		});
		const m3 = appendMessage({
			conversationId: conv.id,
			parentMessageId: m2.id,
			role: 'user',
			parts: [{ type: 'text', text: 'follow-up' }],
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
			parts: [{ type: 'text', text: 'first' }],
		});
		const m2 = appendMessage({
			conversationId: conv.id,
			parentMessageId: m1.id,
			role: 'assistant',
			parts: [{ type: 'text', text: 'reply' }],
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
			modelKind: 'chat',
		});
		const otherMsg = appendMessage({
			conversationId: other.id,
			parentMessageId: null,
			role: 'user',
			parts: [{ type: 'text', text: 'x' }],
		});
		expect(truncateAtMessage(conv.id, otherMsg.id)).toBeNull();
	});
});

describe('branching: siblings + selectBranch', () => {
	function makeConv(userId: string) {
		return createConversation({
			userId,
			endpointId: 'bridge',
			modelId: 'bridge::x',
			modelKind: 'chat',
		});
	}

	function append(
		convId: string,
		parentId: string | null,
		role: 'user' | 'assistant',
		text: string,
	) {
		return appendMessage({
			conversationId: convId,
			parentMessageId: parentId,
			role,
			parts: [{ type: 'text', text }],
		});
	}

	it('walkActiveBranch fills siblingCount=1 / position=1 on a linear chain', () => {
		const u = seedUser();
		const conv = makeConv(u.id);
		const m1 = append(conv.id, null, 'user', 'a');
		const m2 = append(conv.id, m1.id, 'assistant', 'b');
		const branch = walkActiveBranch(conv.id);
		expect(branch.map((m) => m.siblingCount)).toEqual([1, 1]);
		expect(branch.map((m) => m.siblingPosition)).toEqual([1, 1]);
		expect(branch.map((m) => m.siblingIds)).toEqual([[m1.id], [m2.id]]);
	});

	it('walkActiveBranch reports siblings when an alt user message exists', async () => {
		const u = seedUser();
		const conv = makeConv(u.id);
		const root = append(conv.id, null, 'user', 'first prompt');
		const aiA = append(conv.id, root.id, 'assistant', 'A');
		// Edit-shape: a sibling assistant message under the same root.
		await new Promise((r) => setTimeout(r, 5));
		const aiB = append(conv.id, root.id, 'assistant', 'B');
		// active_leaf is currently aiB (last appended). Expect aiB to know
		// it has 2 siblings, position 2.
		const branch = walkActiveBranch(conv.id);
		const tail = branch[branch.length - 1];
		expect(tail.id).toBe(aiB.id);
		expect(tail.siblingCount).toBe(2);
		expect(tail.siblingPosition).toBe(2);
		expect(tail.siblingIds).toEqual([aiA.id, aiB.id]);
	});

	it('selectBranch points active_leaf at the deepest descendant of the picked sibling', async () => {
		const u = seedUser();
		const conv = makeConv(u.id);
		const root = append(conv.id, null, 'user', 'q');
		const aiA = append(conv.id, root.id, 'assistant', 'A');
		const followA = append(conv.id, aiA.id, 'user', 'follow');
		await new Promise((r) => setTimeout(r, 5));
		append(conv.id, root.id, 'assistant', 'B'); // sibling branch — appended last so it's the current active leaf

		// Active leaf is currently aiB. Switch to aiA's branch.
		const r = selectBranch(conv.id, aiA.id);
		// Deepest descendant of aiA is followA.
		expect(r?.newActiveLeaf).toBe(followA.id);
		const branch = walkActiveBranch(conv.id);
		expect(branch.map((m) => m.id)).toEqual([root.id, aiA.id, followA.id]);
	});

	it('selectBranch on a leaf sibling sets active_leaf to that sibling directly', async () => {
		const u = seedUser();
		const conv = makeConv(u.id);
		const root = append(conv.id, null, 'user', 'q');
		const aiA = append(conv.id, root.id, 'assistant', 'A');
		await new Promise((r) => setTimeout(r, 5));
		const aiB = append(conv.id, root.id, 'assistant', 'B');

		// Currently active_leaf is aiB; switch to aiA (a leaf with no
		// descendants).
		expect(selectBranch(conv.id, aiA.id)?.newActiveLeaf).toBe(aiA.id);
		expect(aiB.id).not.toBe(aiA.id);
	});

	it('selectBranch refuses cross-conversation message ids', () => {
		const u = seedUser();
		const a = makeConv(u.id);
		const b = makeConv(u.id);
		const m = append(a.id, null, 'user', 'x');
		expect(selectBranch(b.id, m.id)).toBeNull();
	});

	it('getMessage returns parentMessageId so retry can resolve the parent user msg', () => {
		const u = seedUser();
		const conv = makeConv(u.id);
		const userMsg = append(conv.id, null, 'user', 'q');
		const aiMsg = append(conv.id, userMsg.id, 'assistant', 'a');
		const looked = getMessage(conv.id, aiMsg.id);
		expect(looked?.parentMessageId).toBe(userMsg.id);
		expect(looked?.role).toBe('assistant');
	});

	it('setActiveLeafMessageId is the direct override retry uses', () => {
		const u = seedUser();
		const conv = makeConv(u.id);
		const userMsg = append(conv.id, null, 'user', 'q');
		const aiMsg = append(conv.id, userMsg.id, 'assistant', 'a');
		// active_leaf is aiMsg after the second append. Roll back to userMsg.
		setActiveLeafMessageId(conv.id, userMsg.id);
		const branch = walkActiveBranch(conv.id);
		expect(branch.map((m) => m.id)).toEqual([userMsg.id]);
		// aiMsg row still exists in DB, just not in active branch.
		expect(getMessage(conv.id, aiMsg.id)).not.toBeNull();
	});
});

describe('deleteBranch', () => {
	/**
	 * Build a tree with two sibling user messages (edit branches), each with
	 * an assistant child. Returns ids so individual tests can drive deletions.
	 *
	 *           root user (U0)
	 *           ├── assistant (A0)
	 *           ?
	 *           edit: two sibling users branching off the same parent (null)
	 *
	 * For simplicity we just create two root siblings with assistant children
	 * under each — same shape as "user edits the root message twice."
	 */
	function buildTwoBranches() {
		const u = seedUser();
		const conv = createConversation({
			userId: u.id,
			endpointId: 'bridge',
			modelId: 'bridge::x',
			modelKind: 'chat',
		});
		const u1 = appendMessage({
			conversationId: conv.id,
			parentMessageId: null,
			role: 'user',
			parts: [{ type: 'text', text: 'branch A' }],
		});
		const a1 = appendMessage({
			conversationId: conv.id,
			parentMessageId: u1.id,
			role: 'assistant',
			parts: [{ type: 'text', text: 'A reply' }],
		});
		const u2 = appendMessage({
			conversationId: conv.id,
			parentMessageId: null,
			role: 'user',
			parts: [{ type: 'text', text: 'branch B' }],
		});
		const a2 = appendMessage({
			conversationId: conv.id,
			parentMessageId: u2.id,
			role: 'assistant',
			parts: [{ type: 'text', text: 'B reply' }],
		});
		return { user: u, conv, u1, a1, u2, a2 };
	}

	it('deletes the subtree rooted at the target sibling', () => {
		const { user, conv, u1, a1, u2 } = buildTwoBranches();
		const result = deleteBranch(conv.id, u1.id, user.id);
		expect(result).not.toBeNull();
		expect(result && 'deletedIds' in result).toBe(true);
		if (result && 'deletedIds' in result) {
			// Both u1 (the target) and a1 (its child) should be gone.
			expect(new Set(result.deletedIds)).toEqual(new Set([u1.id, a1.id]));
		}
		// The remaining branch (u2 / a2) survives.
		expect(getMessage(conv.id, u2.id)).not.toBeNull();
		// The deleted messages are actually gone.
		expect(getMessage(conv.id, u1.id)).toBeNull();
		expect(getMessage(conv.id, a1.id)).toBeNull();
	});

	it('reassigns active_leaf to the surviving sibling`s deepest descendant', () => {
		const { user, conv, u1, u2, a2 } = buildTwoBranches();
		// Force active_leaf onto branch A (the one we're about to delete).
		setActiveLeafMessageId(conv.id, u1.id);
		const result = deleteBranch(conv.id, u1.id, user.id);
		expect(result && 'newActiveLeaf' in result).toBe(true);

		// After deletion, active_leaf points at a2 (the deepest descendant of
		// the surviving sibling u2). Without this reassignment the FK's
		// ON DELETE SET NULL would have orphaned the conversation.
		const meta = getConversationMeta(conv.id, user.id);
		expect(meta?.activeLeafMessageId).toBe(a2.id);
		// And the walk from active_leaf naturally builds the surviving branch.
		const branch = walkActiveBranch(conv.id);
		expect(branch.map((m) => m.id)).toEqual([u2.id, a2.id]);
	});

	it('leaves shared media alone (decrement only, no hard-delete) when deleting a branch', () => {
		const { user, conv, u1, a1, a2 } = buildTwoBranches();
		// Generated image referenced by BOTH branches' assistants (e.g. same
		// hash returned by the bridge across runs). Ref count starts at 2.
		// Deleting branch A should drop ref_count to 1 but leave the media
		// in the gallery — branch B still uses it.
		const { id: mediaId } = insertMedia({
			userId: user.id,
			storagePath: 'ab/cd/test.png',
			contentType: 'image/png',
			byteSize: 1024,
			kind: 'image',
			sourceEndpointId: 'bridge',
			sourceModel: 'bridge::x',
			promptExcerpt: null,
		});
		linkMessageMedia(a1.id, mediaId);
		linkMessageMedia(a2.id, mediaId);
		const before = mocks.testDb
			.select({ refCount: media.refCount })
			.from(media)
			.where(eq(media.id, mediaId))
			.get();
		expect(before?.refCount).toBe(2);

		const result = deleteBranch(conv.id, u1.id, user.id);

		// Shared media isn't in toUnlink — branch B still references it.
		expect(result && 'toUnlink' in result && result.toUnlink).toEqual([]);

		// Ref count drops to 1, unreferencedSince stays null, and the
		// row is NOT hard-deleted.
		const after = mocks.testDb
			.select({
				refCount: media.refCount,
				unreferencedSince: media.unreferencedSince,
				hardDeletedAt: media.hardDeletedAt,
			})
			.from(media)
			.where(eq(media.id, mediaId))
			.get();
		expect(after?.refCount).toBe(1);
		expect(after?.unreferencedSince).toBeNull();
		expect(after?.hardDeletedAt).toBeNull();
	});

	it('hard-deletes generated media that exists only on the deleted branch', () => {
		const { user, conv, u1, a1 } = buildTwoBranches();
		// Media referenced ONLY by the to-be-deleted branch — branch-delete
		// treats this as "the rejected variant's image" and reaps it.
		const { id: mediaId } = insertMedia({
			userId: user.id,
			storagePath: 'ab/cd/orphan.png',
			contentType: 'image/png',
			byteSize: 1024,
			kind: 'image',
			sourceEndpointId: 'bridge',
			sourceModel: 'bridge::x',
			promptExcerpt: null,
		});
		linkMessageMedia(a1.id, mediaId);

		const result = deleteBranch(conv.id, u1.id, user.id);

		// Caller gets the storage path back so it can unlink the file
		// from disk post-commit.
		expect(result && 'toUnlink' in result && result.toUnlink).toEqual([
			{ id: mediaId, storagePath: 'ab/cd/orphan.png' },
		]);

		// hardDeletedAt is stamped inside the transaction so the row is
		// invisible to the gallery immediately, even before the disk
		// unlink fires.
		const after = mocks.testDb
			.select({
				refCount: media.refCount,
				hardDeletedAt: media.hardDeletedAt,
			})
			.from(media)
			.where(eq(media.id, mediaId))
			.get();
		expect(after?.hardDeletedAt).not.toBeNull();
		expect(after?.refCount).toBe(0);
	});

	it('does NOT hard-delete uploaded media even when it would orphan', () => {
		const { user, conv, u1, a1 } = buildTwoBranches();
		// Uploaded media (origin='uploaded') follows the purger's auto-sweep
		// path under the library model — it isn't subject to branch-delete's
		// "always purge rejected variants" rule. Useful guarantee: a user
		// attaches a photo to a draft, branches off, then deletes the
		// branch — the source photo (if it was just a file upload) doesn't
		// get nuked along with the rejected output.
		const { id: mediaId } = insertMedia({
			userId: user.id,
			storagePath: 'ab/cd/upload.png',
			contentType: 'image/png',
			byteSize: 2048,
			kind: 'image',
			sourceEndpointId: null,
			sourceModel: null,
			promptExcerpt: null,
			origin: 'uploaded',
		});
		linkMessageMedia(a1.id, mediaId);

		const result = deleteBranch(conv.id, u1.id, user.id);

		// Uploaded media isn't in toUnlink.
		expect(result && 'toUnlink' in result && result.toUnlink).toEqual([]);

		// Not hard-deleted. ref_count drops to 0 and unreferencedSince
		// gets stamped via the normal decrement path; the purger will
		// pick it up on its next sweep.
		const after = mocks.testDb
			.select({
				refCount: media.refCount,
				unreferencedSince: media.unreferencedSince,
				hardDeletedAt: media.hardDeletedAt,
			})
			.from(media)
			.where(eq(media.id, mediaId))
			.get();
		expect(after?.refCount).toBe(0);
		expect(after?.unreferencedSince).not.toBeNull();
		expect(after?.hardDeletedAt).toBeNull();
	});

	it('refuses to delete a branch that has no siblings', () => {
		const u = seedUser();
		const conv = createConversation({
			userId: u.id,
			endpointId: 'bridge',
			modelId: 'bridge::x',
			modelKind: 'chat',
		});
		const root = appendMessage({
			conversationId: conv.id,
			parentMessageId: null,
			role: 'user',
			parts: [{ type: 'text', text: 'only message' }],
		});
		const result = deleteBranch(conv.id, root.id, u.id);
		expect(result).toEqual({ refusedReason: 'no-siblings' });
		// Message is still there.
		expect(getMessage(conv.id, root.id)).not.toBeNull();
	});

	it('returns null when the message does not belong to the conversation', () => {
		const { user, conv } = buildTwoBranches();
		const result = deleteBranch(conv.id, 'not-a-real-message-id', user.id);
		expect(result).toBeNull();
	});
});

describe('countOrphanMediaInConversation', () => {
	// Helpers to keep each test short — most need the same conversation
	// + assistant message shape with media linked.
	function setupConvWithAssistant(userId: string, modelKind: 'image' | 'video' = 'image') {
		const conv = createConversation({
			userId,
			endpointId: 'bridge',
			modelId: `bridge::${modelKind}`,
			modelKind,
		});
		const userMsg = appendMessage({
			conversationId: conv.id,
			parentMessageId: null,
			role: 'user',
			parts: [{ type: 'text', text: 'make something' }],
		});
		const assistantMsg = appendMessage({
			conversationId: conv.id,
			parentMessageId: userMsg.id,
			role: 'assistant',
			parts: [{ type: 'text', text: 'sure' }],
		});
		return { conv, userMsg, assistantMsg };
	}

	function makeGenerated(userId: string, kind: 'image' | 'video' = 'image') {
		return insertMedia({
			userId,
			storagePath: `xx/${Math.random().toString(36).slice(2)}.bin`,
			contentType: kind === 'image' ? 'image/png' : 'video/mp4',
			byteSize: 1024,
			kind,
			sourceEndpointId: 'bridge',
			sourceModel: 'bridge::sdxl',
			promptExcerpt: 'something',
		});
	}

	it('returns zero counts for a conversation with no media', () => {
		const u = seedUser();
		const conv = createConversation({
			userId: u.id,
			endpointId: 'bridge',
			modelId: 'bridge::chat',
			modelKind: 'chat',
		});
		expect(countOrphanMediaInConversation(conv.id, u.id)).toEqual({
			images: 0,
			videos: 0,
		});
	});

	it('counts a unique image whose only reference is in this conversation', () => {
		const u = seedUser();
		const { conv, assistantMsg } = setupConvWithAssistant(u.id);
		const { id: mediaId } = makeGenerated(u.id, 'image');
		linkMessageMedia(assistantMsg.id, mediaId);
		expect(countOrphanMediaInConversation(conv.id, u.id)).toEqual({
			images: 1,
			videos: 0,
		});
	});

	it('counts images and videos separately under their respective keys', () => {
		const u = seedUser();
		const { conv, assistantMsg } = setupConvWithAssistant(u.id);
		const img1 = makeGenerated(u.id, 'image');
		const img2 = makeGenerated(u.id, 'image');
		const vid = makeGenerated(u.id, 'video');
		linkMessageMedia(assistantMsg.id, img1.id);
		linkMessageMedia(assistantMsg.id, img2.id);
		linkMessageMedia(assistantMsg.id, vid.id);
		expect(countOrphanMediaInConversation(conv.id, u.id)).toEqual({
			images: 2,
			videos: 1,
		});
	});

	it('excludes media also referenced by a different conversation (would not orphan)', () => {
		// Shared media: ref_count = 2, with one ref in conv A and one in
		// conv B. Deleting conv A would drop ref_count to 1, not zero —
		// so it doesn't orphan, and should NOT show up in the count.
		const u = seedUser();
		const a = setupConvWithAssistant(u.id);
		const b = setupConvWithAssistant(u.id);
		const { id: shared } = makeGenerated(u.id, 'image');
		linkMessageMedia(a.assistantMsg.id, shared);
		linkMessageMedia(b.assistantMsg.id, shared);
		expect(countOrphanMediaInConversation(a.conv.id, u.id)).toEqual({
			images: 0,
			videos: 0,
		});
	});

	it('counts media linked from multiple messages within one conversation as a single orphan', () => {
		// Same media linked from two different messages in the same
		// conversation (e.g. across edit siblings via auto-attach). The
		// row appears twice in the join but `localCount == ref_count`
		// is the right comparison — both refs go away together when
		// the conversation is deleted, so it's one orphan.
		const u = seedUser();
		const { conv, userMsg, assistantMsg } = setupConvWithAssistant(u.id);
		const editedAssistant = appendMessage({
			conversationId: conv.id,
			parentMessageId: userMsg.id, // sibling of the original assistantMsg
			role: 'assistant',
			parts: [{ type: 'text', text: 'second variant' }],
		});
		const { id: mediaId } = makeGenerated(u.id, 'image');
		linkMessageMedia(assistantMsg.id, mediaId);
		linkMessageMedia(editedAssistant.id, mediaId);
		// ref_count = 2 (both message_media rows). Both refs are inside
		// the conversation, so the orphan count is 1.
		expect(countOrphanMediaInConversation(conv.id, u.id)).toEqual({
			images: 1,
			videos: 0,
		});
	});

	it('excludes uploaded media regardless of orphan status', () => {
		// Uploads aren't part of the gallery so the dialog never asks
		// the user whether to purge them; the purger handles them on
		// its own schedule.
		const u = seedUser();
		const { conv, assistantMsg } = setupConvWithAssistant(u.id);
		const { id: uploaded } = insertMedia({
			userId: u.id,
			storagePath: 'up/up.png',
			contentType: 'image/png',
			byteSize: 1024,
			kind: 'image',
			sourceEndpointId: null,
			sourceModel: null,
			promptExcerpt: null,
			origin: 'uploaded',
		});
		linkMessageMedia(assistantMsg.id, uploaded);
		expect(countOrphanMediaInConversation(conv.id, u.id)).toEqual({
			images: 0,
			videos: 0,
		});
	});

	it('excludes already hard-deleted media', () => {
		// Already gone from the gallery — shouldn't double-count toward
		// "and N more will be deleted."
		const u = seedUser();
		const { conv, assistantMsg } = setupConvWithAssistant(u.id);
		const { id: mediaId } = makeGenerated(u.id, 'image');
		linkMessageMedia(assistantMsg.id, mediaId);
		mocks.testDb
			.update(media)
			.set({ hardDeletedAt: Date.now() })
			.where(eq(media.id, mediaId))
			.run();
		expect(countOrphanMediaInConversation(conv.id, u.id)).toEqual({
			images: 0,
			videos: 0,
		});
	});
});

describe('deleteConversation with the deleteMedia flag', () => {
	function makeGenerated(userId: string, storagePath: string) {
		return insertMedia({
			userId,
			storagePath,
			contentType: 'image/png',
			byteSize: 1024,
			kind: 'image',
			sourceEndpointId: 'bridge',
			sourceModel: 'bridge::sdxl',
			promptExcerpt: 'something',
		});
	}

	it('returns empty toUnlink when the conversation has no media', () => {
		const u = seedUser();
		const conv = createConversation({
			userId: u.id,
			endpointId: 'bridge',
			modelId: 'bridge::chat',
			modelKind: 'chat',
		});
		const result = deleteConversation(conv.id, u.id, { deleteMedia: true });
		expect(result.ok).toBe(true);
		expect(result.toUnlink).toEqual([]);
	});

	it('without the flag: leaves orphan media as a soft orphan (no hard-delete, no toUnlink)', () => {
		// Default behavior — media stays in the gallery under the
		// library model. ref_count drops to 0 but `hardDeletedAt`
		// stays null.
		const u = seedUser();
		const conv = createConversation({
			userId: u.id,
			endpointId: 'bridge',
			modelId: 'bridge::image',
			modelKind: 'image',
		});
		const msg = appendMessage({
			conversationId: conv.id,
			parentMessageId: null,
			role: 'assistant',
			parts: [{ type: 'text', text: 'made it' }],
		});
		const { id: mediaId } = makeGenerated(u.id, 'aa/bb/preserved.png');
		linkMessageMedia(msg.id, mediaId);

		const result = deleteConversation(conv.id, u.id);
		expect(result.ok).toBe(true);
		expect(result.toUnlink).toEqual([]);

		const row = mocks.testDb.select().from(media).where(eq(media.id, mediaId)).get();
		expect(row?.hardDeletedAt).toBeNull();
		expect(row?.refCount).toBe(0);
	});

	it('with the flag: hard-deletes unique generated media and returns its storage path', () => {
		const u = seedUser();
		const conv = createConversation({
			userId: u.id,
			endpointId: 'bridge',
			modelId: 'bridge::image',
			modelKind: 'image',
		});
		const msg = appendMessage({
			conversationId: conv.id,
			parentMessageId: null,
			role: 'assistant',
			parts: [{ type: 'text', text: 'made it' }],
		});
		const { id: mediaId } = makeGenerated(u.id, 'aa/bb/orphan.png');
		linkMessageMedia(msg.id, mediaId);

		const result = deleteConversation(conv.id, u.id, { deleteMedia: true });
		expect(result.ok).toBe(true);
		expect(result.toUnlink).toEqual([{ id: mediaId, storagePath: 'aa/bb/orphan.png' }]);

		const row = mocks.testDb.select().from(media).where(eq(media.id, mediaId)).get();
		expect(row?.hardDeletedAt).not.toBeNull();
	});

	it('with the flag: preserves shared media used by another conversation', () => {
		// Media referenced by two conversations. Deleting the first
		// with deleteMedia=true should NOT touch the media — the
		// second conversation still references it, so ref_count drops
		// to 1 (not 0) and no hard-delete fires.
		const u = seedUser();
		const convA = createConversation({
			userId: u.id,
			endpointId: 'bridge',
			modelId: 'bridge::image',
			modelKind: 'image',
		});
		const msgA = appendMessage({
			conversationId: convA.id,
			parentMessageId: null,
			role: 'assistant',
			parts: [{ type: 'text', text: 'a' }],
		});
		const convB = createConversation({
			userId: u.id,
			endpointId: 'bridge',
			modelId: 'bridge::image',
			modelKind: 'image',
		});
		const msgB = appendMessage({
			conversationId: convB.id,
			parentMessageId: null,
			role: 'assistant',
			parts: [{ type: 'text', text: 'b' }],
		});
		const { id: shared } = makeGenerated(u.id, 'aa/bb/shared.png');
		linkMessageMedia(msgA.id, shared);
		linkMessageMedia(msgB.id, shared);

		const result = deleteConversation(convA.id, u.id, { deleteMedia: true });
		expect(result.ok).toBe(true);
		expect(result.toUnlink).toEqual([]); // shared, not orphaned

		const row = mocks.testDb.select().from(media).where(eq(media.id, shared)).get();
		expect(row?.hardDeletedAt).toBeNull();
		expect(row?.refCount).toBe(1);
	});

	it('with the flag: does not hard-delete uploaded media even when it would orphan', () => {
		// Uploads aren't part of the user's gallery decision — they
		// follow the auto-purger's own sweep schedule. Even with the
		// flag set, uploaded media linked to the conversation gets
		// only its ref_count decremented (which triggers the
		// existing `unreferencedSince` stamp via the decrement path).
		const u = seedUser();
		const conv = createConversation({
			userId: u.id,
			endpointId: 'bridge',
			modelId: 'bridge::image',
			modelKind: 'image',
		});
		const msg = appendMessage({
			conversationId: conv.id,
			parentMessageId: null,
			role: 'assistant',
			parts: [{ type: 'text', text: 'with upload attached' }],
		});
		const { id: uploaded } = insertMedia({
			userId: u.id,
			storagePath: 'up/me.png',
			contentType: 'image/png',
			byteSize: 1024,
			kind: 'image',
			sourceEndpointId: null,
			sourceModel: null,
			promptExcerpt: null,
			origin: 'uploaded',
		});
		linkMessageMedia(msg.id, uploaded);

		const result = deleteConversation(conv.id, u.id, { deleteMedia: true });
		expect(result.ok).toBe(true);
		expect(result.toUnlink).toEqual([]);

		const row = mocks.testDb.select().from(media).where(eq(media.id, uploaded)).get();
		expect(row?.hardDeletedAt).toBeNull();
		expect(row?.refCount).toBe(0);
		expect(row?.unreferencedSince).not.toBeNull();
	});

	it('returns ok=false with empty toUnlink for a cross-user delete attempt', () => {
		// Belt-and-suspenders ownership check — the API also
		// enforces this via locals.user, but the DB-level guard
		// should hold independently.
		const u1 = seedUser();
		const u2 = seedUser();
		const conv = createConversation({
			userId: u1.id,
			endpointId: 'bridge',
			modelId: 'bridge::image',
			modelKind: 'image',
		});
		const msg = appendMessage({
			conversationId: conv.id,
			parentMessageId: null,
			role: 'assistant',
			parts: [{ type: 'text', text: 'something' }],
		});
		const { id: mediaId } = makeGenerated(u1.id, 'aa/bb/cross.png');
		linkMessageMedia(msg.id, mediaId);

		const result = deleteConversation(conv.id, u2.id, { deleteMedia: true });
		expect(result.ok).toBe(false);
		expect(result.toUnlink).toEqual([]);

		// Conversation and media both still intact for the real owner.
		expect(getConversationDetail(conv.id, u1.id)).not.toBeNull();
		const row = mocks.testDb.select().from(media).where(eq(media.id, mediaId)).get();
		expect(row?.hardDeletedAt).toBeNull();
		expect(row?.refCount).toBe(1);
	});
});

describe('resolveParentForUserMessage', () => {
	// Shape under test: pure function that maps the route-level inputs
	// (conversation context + optional client-provided routing fields)
	// to "what should the new user message's parent_message_id be?".
	// Three logical cases (edit / explicit parent / continue leaf) and
	// a couple of validation failure modes, all driven by table-ish
	// individual `it()` blocks for readability.

	function setupConvWithBranch(userId: string) {
		const conv = createConversation({
			userId,
			endpointId: 'bridge',
			modelId: 'bridge::chat',
			modelKind: 'chat',
		});
		const root = appendMessage({
			conversationId: conv.id,
			parentMessageId: null,
			role: 'user',
			parts: [{ type: 'text', text: 'first' }],
		});
		const reply = appendMessage({
			conversationId: conv.id,
			parentMessageId: root.id,
			role: 'assistant',
			parts: [{ type: 'text', text: 'ok' }],
		});
		const followUp = appendMessage({
			conversationId: conv.id,
			parentMessageId: reply.id,
			role: 'user',
			parts: [{ type: 'text', text: 'second' }],
		});
		setActiveLeafMessageId(conv.id, followUp.id);
		return { conv, root, reply, followUp };
	}

	it('editedMessageId pointing at the conversation root returns parentMessageId=null', () => {
		// This is the bug-fix regression test: editing the conversation's
		// first user message should produce a fresh root sibling, NOT
		// an append onto the current leaf. Pre-fix the route handler
		// dropped null parents on the wire and the server fell back to
		// activeLeaf — silently breaking branching for root edits.
		const u = seedUser();
		const { conv, root } = setupConvWithBranch(u.id);
		const result = resolveParentForUserMessage({
			conversationId: conv.id,
			activeLeafMessageId: 'should-be-ignored-because-editedMessageId-wins',
			editedMessageId: root.id,
		});
		expect(result).toEqual({ ok: true, parentMessageId: null });
	});

	it('editedMessageId pointing at a non-root message returns that message`s parent', () => {
		// Standard edit-of-mid-conversation case: editing the followUp
		// user message should make the new sibling share the followUp's
		// parent (the assistant reply).
		const u = seedUser();
		const { conv, reply, followUp } = setupConvWithBranch(u.id);
		const result = resolveParentForUserMessage({
			conversationId: conv.id,
			activeLeafMessageId: followUp.id,
			editedMessageId: followUp.id,
		});
		expect(result).toEqual({ ok: true, parentMessageId: reply.id });
	});

	it('editedMessageId not found returns a discriminated failure', () => {
		const u = seedUser();
		const { conv } = setupConvWithBranch(u.id);
		const result = resolveParentForUserMessage({
			conversationId: conv.id,
			activeLeafMessageId: null,
			editedMessageId: 'no-such-message',
		});
		expect(result).toEqual({
			ok: false,
			reason: 'edited-message-not-found',
			id: 'no-such-message',
		});
	});

	it('editedMessageId from a different conversation is treated as not-found', () => {
		// Cross-conversation safety: the helper`s getMessage lookup is
		// scoped to (conversationId, messageId) so a request can`t
		// branch off a sibling that lives in someone else`s
		// conversation. We don`t test cross-USER scoping here because
		// the route handler does that authentication-level guard before
		// reaching this helper; this is the scoping-within-the-DB layer.
		const u = seedUser();
		const a = setupConvWithBranch(u.id);
		const b = setupConvWithBranch(u.id);
		const result = resolveParentForUserMessage({
			conversationId: b.conv.id,
			activeLeafMessageId: b.followUp.id,
			editedMessageId: a.root.id,
		});
		expect(result.ok).toBe(false);
	});

	it('parentMessageId is used when editedMessageId is absent', () => {
		const u = seedUser();
		const { conv, reply } = setupConvWithBranch(u.id);
		const result = resolveParentForUserMessage({
			conversationId: conv.id,
			activeLeafMessageId: null,
			parentMessageId: reply.id,
		});
		expect(result).toEqual({ ok: true, parentMessageId: reply.id });
	});

	it('parentMessageId not found returns a discriminated failure', () => {
		const u = seedUser();
		const { conv } = setupConvWithBranch(u.id);
		const result = resolveParentForUserMessage({
			conversationId: conv.id,
			activeLeafMessageId: null,
			parentMessageId: 'no-such-message',
		});
		expect(result).toEqual({
			ok: false,
			reason: 'parent-message-not-found',
			id: 'no-such-message',
		});
	});

	it('editedMessageId wins over parentMessageId when both are present', () => {
		// Defensive ordering: if a future caller sends both fields,
		// editedMessageId takes precedence (it carries more semantic
		// intent — "this is an edit"). The result should match what
		// you`d get from editedMessageId alone, even when
		// parentMessageId points somewhere different.
		const u = seedUser();
		const { conv, root, reply } = setupConvWithBranch(u.id);
		const result = resolveParentForUserMessage({
			conversationId: conv.id,
			activeLeafMessageId: null,
			editedMessageId: root.id,
			parentMessageId: reply.id, // would resolve to reply.id if used
		});
		expect(result).toEqual({ ok: true, parentMessageId: null });
	});

	it('falls through to activeLeafMessageId when neither field is provided', () => {
		const u = seedUser();
		const { conv, followUp } = setupConvWithBranch(u.id);
		const result = resolveParentForUserMessage({
			conversationId: conv.id,
			activeLeafMessageId: followUp.id,
		});
		expect(result).toEqual({ ok: true, parentMessageId: followUp.id });
	});

	it('falls through to null when neither field is provided and the leaf is null (new conversation)', () => {
		// Brand-new conversation with no messages yet. The leaf is null,
		// and the resolved parent should also be null — the first user
		// message becomes the conversation root.
		const u = seedUser();
		const conv = createConversation({
			userId: u.id,
			endpointId: 'bridge',
			modelId: 'bridge::chat',
			modelKind: 'chat',
		});
		const result = resolveParentForUserMessage({
			conversationId: conv.id,
			activeLeafMessageId: null,
		});
		expect(result).toEqual({ ok: true, parentMessageId: null });
	});

	it('treats empty-string editedMessageId / parentMessageId as absent', () => {
		// JSON null / undefined / missing key all serialize to "no
		// field" on the wire and we don`t want to throw 400 for that;
		// but an over-eager client could plausibly send "" — we should
		// also treat that as absent rather than throwing
		// "editedMessageId `` not found".
		const u = seedUser();
		const { conv, followUp } = setupConvWithBranch(u.id);
		const result = resolveParentForUserMessage({
			conversationId: conv.id,
			activeLeafMessageId: followUp.id,
			editedMessageId: '',
			parentMessageId: '',
		});
		// Falls through to activeLeafMessageId.
		expect(result).toEqual({ ok: true, parentMessageId: followUp.id });
	});
});

describe('findUserMessageAncestor', () => {
	// Powers the multi-iteration retry path: a user clicking retry on
	// the final assistant of a tool turn (whose immediate parent is a
	// `tool` message, not a user message) needs the new regeneration
	// to anchor at the user message that started the whole turn.

	function seedConv(userId: string) {
		return createConversation({
			userId,
			endpointId: 'bridge',
			modelId: 'bridge::x',
			modelKind: 'chat',
		});
	}

	function append(
		conversationId: string,
		parentMessageId: string | null,
		role: 'system' | 'user' | 'assistant' | 'tool',
	) {
		return appendMessage({
			conversationId,
			parentMessageId,
			role,
			parts: role === 'tool' ? [] : [{ type: 'text', text: role }],
			contentHtml: null,
			reasoningText: null,
			finishReason: null,
			modelUsed: null,
			tokensIn: null,
			tokensOut: null,
		});
	}

	it('returns the immediate parent when retry target is a direct child of a user message', () => {
		// Single-iteration case: user → assistant. Retry on the
		// assistant finds the user one hop up.
		const u = seedUser();
		const c = seedConv(u.id);
		const userMsg = append(c.id, null, 'user');
		const asst = append(c.id, userMsg.id, 'assistant');
		const ancestor = findUserMessageAncestor(c.id, asst.id);
		expect(ancestor?.id).toBe(userMsg.id);
	});

	it('walks up through assistant + tool messages to find the user (multi-iteration tool turn)', () => {
		// user → asst_0 (tool_call) → tool_0 → asst_1 (final text).
		// Retry on asst_1 must skip past tool_0 and asst_0 to find user.
		const u = seedUser();
		const c = seedConv(u.id);
		const userMsg = append(c.id, null, 'user');
		const asst0 = append(c.id, userMsg.id, 'assistant');
		const tool0 = append(c.id, asst0.id, 'tool');
		const asst1 = append(c.id, tool0.id, 'assistant');
		expect(findUserMessageAncestor(c.id, asst1.id)?.id).toBe(userMsg.id);
		// Retry on the MIDDLE assistant of the chain finds the same user.
		expect(findUserMessageAncestor(c.id, asst0.id)?.id).toBe(userMsg.id);
	});

	it('walks across multi-iteration tool turns with several tool round-trips', () => {
		// user → asst_0 → tool_0 → asst_1 → tool_1 → asst_2.
		const u = seedUser();
		const c = seedConv(u.id);
		const userMsg = append(c.id, null, 'user');
		const asst0 = append(c.id, userMsg.id, 'assistant');
		const tool0 = append(c.id, asst0.id, 'tool');
		const asst1 = append(c.id, tool0.id, 'assistant');
		const tool1 = append(c.id, asst1.id, 'tool');
		const asst2 = append(c.id, tool1.id, 'assistant');
		expect(findUserMessageAncestor(c.id, asst2.id)?.id).toBe(userMsg.id);
	});

	it('returns the user message itself when the start id is already a user message', () => {
		const u = seedUser();
		const c = seedConv(u.id);
		const userMsg = append(c.id, null, 'user');
		expect(findUserMessageAncestor(c.id, userMsg.id)?.id).toBe(userMsg.id);
	});

	it('returns null when the chain has no user message (root assistant)', () => {
		// Shouldn't happen in practice but defensive — root is an
		// assistant somehow, no user ancestor exists.
		const u = seedUser();
		const c = seedConv(u.id);
		const rootAsst = append(c.id, null, 'assistant');
		expect(findUserMessageAncestor(c.id, rootAsst.id)).toBeNull();
	});

	it('returns null when the start message does not exist', () => {
		const u = seedUser();
		const c = seedConv(u.id);
		expect(findUserMessageAncestor(c.id, 'nonexistent-id')).toBeNull();
	});
});

describe('multi-model fan-out: sibling appends + active_leaf pinning', () => {
	function seedConvWithUser() {
		const u = seedUser();
		const conv = createConversation({
			userId: u.id,
			endpointId: 'bridge',
			modelId: 'bridge::base',
			modelKind: 'chat',
		});
		const user = appendMessage({
			conversationId: conv.id,
			parentMessageId: null,
			role: 'user',
			parts: [{ type: 'text', text: 'compare these' }],
		});
		return { u, conv, user };
	}

	it('advanceActiveLeaf:false leaves the leaf pinned at the shared user message', () => {
		const { u, conv, user } = seedConvWithUser();
		// The /prepare step put the leaf on the user message.
		expect(getConversationDetail(conv.id, u.id)?.activeLeafMessageId).toBe(user.id);

		// Three fan-out branches land as siblings, none advancing the leaf.
		const a = appendMessage({
			conversationId: conv.id,
			parentMessageId: user.id,
			role: 'assistant',
			parts: [{ type: 'text', text: 'from model A' }],
			modelUsed: 'bridge::a',
			advanceActiveLeaf: false,
		});
		const b = appendMessage({
			conversationId: conv.id,
			parentMessageId: user.id,
			role: 'assistant',
			parts: [{ type: 'text', text: 'from model B' }],
			modelUsed: 'bridge::b',
			advanceActiveLeaf: false,
		});

		// Leaf still on the user message — neither branch stole it.
		expect(getConversationDetail(conv.id, u.id)?.activeLeafMessageId).toBe(user.id);
		// Both siblings exist under the user message with their own model tag.
		const sibs = walkActiveBranch(conv.id);
		expect(sibs.map((m) => m.id)).toEqual([user.id]); // active branch is just the user msg
		// Picking one advances the leaf into that branch.
		const sel = selectBranch(conv.id, a.id);
		expect(sel?.newActiveLeaf).toBe(a.id);
		expect(getConversationDetail(conv.id, u.id)?.activeLeafMessageId).toBe(a.id);
		// The unpicked sibling is still in the tree (reachable as a branch).
		expect(getMessage(conv.id, b.id)?.id).toBe(b.id);
	});

	it('default append still advances the leaf (single-send back-compat)', () => {
		const { u, conv, user } = seedConvWithUser();
		const a = appendMessage({
			conversationId: conv.id,
			parentMessageId: user.id,
			role: 'assistant',
			parts: [{ type: 'text', text: 'normal reply' }],
			modelUsed: 'bridge::base',
		});
		expect(getConversationDetail(conv.id, u.id)?.activeLeafMessageId).toBe(a.id);
	});

	it('getSiblingAssistants returns the assistant children in order with modelUsed', () => {
		const { conv, user } = seedConvWithUser();
		const a = appendMessage({
			conversationId: conv.id,
			parentMessageId: user.id,
			role: 'assistant',
			parts: [{ type: 'text', text: 'A' }],
			modelUsed: 'bridge::a',
			advanceActiveLeaf: false,
		});
		const b = appendMessage({
			conversationId: conv.id,
			parentMessageId: user.id,
			role: 'assistant',
			parts: [{ type: 'text', text: 'B' }],
			modelUsed: 'bridge::b',
			advanceActiveLeaf: false,
		});
		// Order is createdAt-then-id (deterministic); both siblings present,
		// each carrying its own model tag. The live view orders columns by
		// client dispatch order, so we assert the pairing, not the sequence.
		const sibs = getSiblingAssistants(conv.id, user.id);
		expect(new Set(sibs.map((m) => m.id))).toEqual(new Set([a.id, b.id]));
		const byId = new Map(sibs.map((m) => [m.id, m.modelUsed]));
		expect(byId.get(a.id)).toBe('bridge::a');
		expect(byId.get(b.id)).toBe('bridge::b');
	});

	it('getSiblingAssistants surfaces each image result’s source input (split provenance)', () => {
		const { u, conv, user } = seedConvWithUser();
		const inputImg = insertMedia({
			userId: u.id,
			storagePath: 'ab/cd/input.png',
			contentType: 'image/png',
			byteSize: 1024,
			kind: 'image',
			sourceEndpointId: null,
			sourceModel: null,
			promptExcerpt: null,
			origin: 'uploaded',
		});
		// One assistant image sibling whose output media records inputImg as its
		// source; a second whose output has no source (plain text-to-image).
		const editOut = insertMedia({
			userId: u.id,
			storagePath: 'ab/cd/edit.png',
			contentType: 'image/png',
			byteSize: 2048,
			kind: 'image',
			sourceEndpointId: 'bridge',
			sourceModel: 'bridge::sdxl',
			promptExcerpt: 'cartoon',
			sourceMediaId: inputImg.id,
		});
		const plainOut = insertMedia({
			userId: u.id,
			storagePath: 'ab/cd/plain.png',
			contentType: 'image/png',
			byteSize: 2048,
			kind: 'image',
			sourceEndpointId: 'bridge',
			sourceModel: 'bridge::sdxl',
			promptExcerpt: 'a panda',
		});
		const edited = appendMessage({
			conversationId: conv.id,
			parentMessageId: user.id,
			role: 'assistant',
			parts: [{ type: 'image', mediaId: editOut.id }],
			modelUsed: 'bridge::sdxl',
			advanceActiveLeaf: false,
		});
		const plain = appendMessage({
			conversationId: conv.id,
			parentMessageId: user.id,
			role: 'assistant',
			parts: [{ type: 'image', mediaId: plainOut.id }],
			modelUsed: 'bridge::sdxl',
			advanceActiveLeaf: false,
		});
		const byId = new Map(
			getSiblingAssistants(conv.id, user.id).map((m) => [m.id, m.sourceMediaId]),
		);
		expect(byId.get(edited.id)).toBe(inputImg.id);
		expect(byId.get(plain.id)).toBeNull();
	});

	it('getSiblingAssistants excludes non-assistant children and other parents', () => {
		const { conv, user } = seedConvWithUser();
		const a = appendMessage({
			conversationId: conv.id,
			parentMessageId: user.id,
			role: 'assistant',
			parts: [{ type: 'text', text: 'A' }],
			modelUsed: 'bridge::a',
			advanceActiveLeaf: false,
		});
		// A tool message under the same parent must not appear as a column.
		appendMessage({
			conversationId: conv.id,
			parentMessageId: user.id,
			role: 'tool',
			parts: [],
			advanceActiveLeaf: false,
		});
		// A reply under a *different* user message must not leak in.
		const user2 = appendMessage({
			conversationId: conv.id,
			parentMessageId: a.id,
			role: 'user',
			parts: [{ type: 'text', text: 'next' }],
		});
		appendMessage({
			conversationId: conv.id,
			parentMessageId: user2.id,
			role: 'assistant',
			parts: [{ type: 'text', text: 'C' }],
			modelUsed: 'bridge::c',
		});
		expect(getSiblingAssistants(conv.id, user.id).map((m) => m.id)).toEqual([a.id]);
	});
});

const fakeEndpoint = {
	id: 'bridge',
	displayName: 'Bridge',
	baseUrl: 'http://x/v1',
	apiKey: null,
	requestTimeoutSeconds: 30,
	providerQuirk: 'passthrough',
	groupBy: 'endpoint',
	supportsTools: false,
	maxConcurrent: 4,
} satisfies LoadedEndpoint;

describe('fan-out marker (parked-fan-out rehydration)', () => {
	function seedFanout() {
		const u = seedUser();
		const conv = createConversation({
			userId: u.id,
			endpointId: 'bridge',
			modelId: 'bridge::base',
			modelKind: 'chat',
		});
		const user = appendMessage({
			conversationId: conv.id,
			parentMessageId: null,
			role: 'user',
			parts: [{ type: 'text', text: 'compare' }],
		});
		const a = appendMessage({
			conversationId: conv.id,
			parentMessageId: user.id,
			role: 'assistant',
			parts: [{ type: 'text', text: 'A' }],
			modelUsed: 'bridge::a',
			advanceActiveLeaf: false,
		});
		const b = appendMessage({
			conversationId: conv.id,
			parentMessageId: user.id,
			role: 'assistant',
			parts: [{ type: 'text', text: 'B' }],
			modelUsed: 'bridge::b',
			advanceActiveLeaf: false,
		});
		return { u, conv, user, a, b };
	}

	it('set/get round-trips and selectBranch clears the marker', () => {
		const { u, conv, user, a } = seedFanout();
		setFanoutParent(conv.id, user.id);
		expect(getFanoutParent(conv.id)).toBe(user.id);

		// Picking a winner resolves the fan-out → marker cleared, leaf advanced.
		selectBranch(conv.id, a.id);
		expect(getFanoutParent(conv.id)).toBeNull();
		expect(getConversationDetail(conv.id, u.id)?.activeLeafMessageId).toBe(a.id);
	});

	it('deleteBranch keeps the parked leaf when discarding an off-branch sibling', () => {
		const { u, conv, user, a, b } = seedFanout();
		setFanoutParent(conv.id, user.id);
		// Leaf is parked at the user message (advanceActiveLeaf:false above).
		expect(getConversationDetail(conv.id, u.id)?.activeLeafMessageId).toBe(user.id);

		// Discard sibling A — the leaf must stay parked at the user message
		// (not jump to B), so the compare grid survives the prune.
		const res = deleteBranch(conv.id, a.id, u.id);
		expect(res && 'deletedIds' in res).toBe(true);
		expect(getConversationDetail(conv.id, u.id)?.activeLeafMessageId).toBe(user.id);
		// B remains; the marker is untouched (still pruning).
		expect(getMessage(conv.id, b.id)?.id).toBe(b.id);
		expect(getFanoutParent(conv.id)).toBe(user.id);
	});

	it('deleteBranch clears the marker (no FK error) when the parked anchor is deleted', () => {
		const { u, conv, user } = seedFanout();
		// Give the parked user message a sibling (e.g. an earlier edit) so
		// deleteBranch has a replacement and actually removes `user` + its
		// fan-out subtree.
		appendMessage({
			conversationId: conv.id,
			parentMessageId: null,
			role: 'user',
			parts: [{ type: 'text', text: 'other' }],
			advanceActiveLeaf: false,
		});
		setFanoutParent(conv.id, user.id);
		// Deleting the parked anchor must null the marker rather than FK-error on
		// it (the live FK is NO ACTION — the app clears the reference itself).
		const res = deleteBranch(conv.id, user.id, u.id);
		expect(res && 'deletedIds' in res).toBe(true);
		expect(getFanoutParent(conv.id)).toBeNull();
	});

	it('deleteBranch still moves the leaf when you delete the branch you are on', () => {
		// Regression guard for the sibling-nav case (leaf inside the deleted
		// subtree) — must keep advancing to a replacement sibling.
		const { u, conv, user, a, b } = seedFanout();
		// Make A the active leaf (as if the user navigated onto it).
		selectBranch(conv.id, a.id);
		expect(getConversationDetail(conv.id, u.id)?.activeLeafMessageId).toBe(a.id);
		const res = deleteBranch(conv.id, a.id, u.id);
		expect(res && 'newActiveLeaf' in res ? res.newActiveLeaf : null).toBe(b.id);
		void user;
	});

	it('a leaf-advancing append clears a stale marker', () => {
		const { conv, user } = seedFanout();
		setFanoutParent(conv.id, user.id);
		// A normal (leaf-advancing) message after the comparison resolves it.
		appendMessage({
			conversationId: conv.id,
			parentMessageId: user.id,
			role: 'assistant',
			parts: [{ type: 'text', text: 'follow-up' }],
		});
		expect(getFanoutParent(conv.id)).toBeNull();
	});

	it('truncateAtMessage clears the marker', () => {
		const { conv, user, a } = seedFanout();
		setFanoutParent(conv.id, user.id);
		truncateAtMessage(conv.id, a.id);
		expect(getFanoutParent(conv.id)).toBeNull();
	});

	it('getFanoutRecoveryState reports siblings + pending only for a parked fan-out', () => {
		const { conv, user, a, b } = seedFanout();
		// Not parked yet (no marker) → nothing to recover.
		expect(getFanoutRecoveryState(conv.id, user.id)).toEqual({
			parentMessageId: null,
			kind: null,
			siblings: [],
			pending: 0,
			pendingModelIds: [],
		});

		setFanoutParent(conv.id, user.id);
		resetInFlight();
		const state = getFanoutRecoveryState(conv.id, user.id);
		expect(state.parentMessageId).toBe(user.id);
		expect(new Set(state.siblings.map((m) => m.id))).toEqual(new Set([a.id, b.id]));
		expect(state.pending).toBe(0);

		// Two branches still generating → pending + kind + per-branch model ids
		// reflect the in-flight entries (so the recovered grid labels each
		// placeholder by model, like the live grid).
		registerInFlight(conv.id, fakeEndpoint, 'br0', 'image', 'bridge::sdxl');
		registerInFlight(conv.id, fakeEndpoint, 'br1', 'image', 'bridge::flux');
		const inflightState = getFanoutRecoveryState(conv.id, user.id);
		expect(inflightState.pending).toBe(2);
		expect(inflightState.kind).toBe('image');
		expect(new Set(inflightState.pendingModelIds)).toEqual(
			new Set(['bridge::sdxl', 'bridge::flux']),
		);
		resetInFlight();

		// Marker that no longer matches the active leaf isn't surfaced.
		expect(getFanoutRecoveryState(conv.id, 'some-other-leaf').parentMessageId).toBeNull();
	});

	it('a fan-out branch append (advanceActiveLeaf:false) leaves the marker set', () => {
		const { conv, user } = seedFanout();
		setFanoutParent(conv.id, user.id);
		appendMessage({
			conversationId: conv.id,
			parentMessageId: user.id,
			role: 'assistant',
			parts: [{ type: 'text', text: 'another branch' }],
			advanceActiveLeaf: false,
		});
		expect(getFanoutParent(conv.id)).toBe(user.id);
	});
});
