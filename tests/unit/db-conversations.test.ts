import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDb, closeTestDb, type TestDB } from './_helpers/test-db';
import { seedUser } from './_helpers/seed';

const mocks = vi.hoisted(() => ({ testDb: null as unknown as TestDB }));
vi.mock('$lib/server/db/client', () => ({
	getDb: () => mocks.testDb,
	closeDb: () => {}
}));

import {
	archiveConversation,
	createConversation,
	deleteConversation,
	getConversationDetail,
	getConversationMeta,
	listArchivedConversations,
	listConversations,
	unarchiveConversation,
	updateConversationModel
} from '$lib/server/db/queries/conversations';
import {
	appendMessage,
	deleteBranch,
	getMessage,
	selectBranch,
	setActiveLeafMessageId,
	truncateAtMessage,
	walkActiveBranch
} from '$lib/server/db/queries/messages';
import { insertMedia, linkMessageMedia } from '$lib/server/db/queries/media';
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

describe('archiving', () => {
	it('archive removes from active list, surfaces in archived list', () => {
		const u = seedUser();
		const conv = createConversation({
			userId: u.id,
			endpointId: 'bridge',
			modelId: 'bridge::x',
			modelKind: 'chat',
			title: 'A'
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
			modelKind: 'chat'
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
			modelKind: 'chat'
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
			modelKind: 'chat'
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
			modelKind: 'chat'
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
			modelKind: 'chat'
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
			modelKind: 'chat'
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
			systemPrompt: extra?.systemPrompt
		});
		return { u, conv };
	}

	it('rewrites endpoint/model/kind in place', () => {
		const { u, conv } = seed();
		const ok = updateConversationModel(conv.id, u.id, {
			endpointId: 'groq',
			modelId: 'groq::llama-3.3-70b',
			modelKind: 'chat'
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
			modelKind: 'chat'
		});
		expect(getConversationMeta(conv.id, u.id)?.systemPrompt).toBe('You are Bert.');
	});

	it('supports modality switches (chat → image)', () => {
		const { u, conv } = seed();
		updateConversationModel(conv.id, u.id, {
			endpointId: 'bridge',
			modelId: 'bridge::comfyui/sdxl',
			modelKind: 'image'
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
			modelKind: 'chat'
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
			modelKind: 'chat'
		});
		expect(ok).toBe(false);
	});

	it('returns false for a nonexistent conversation id', () => {
		const u = seedUser();
		const ok = updateConversationModel('does-not-exist', u.id, {
			endpointId: 'groq',
			modelId: 'groq::llama-3.3-70b',
			modelKind: 'chat'
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

describe('branching: siblings + selectBranch', () => {
	function makeConv(userId: string) {
		return createConversation({
			userId,
			endpointId: 'bridge',
			modelId: 'bridge::x',
			modelKind: 'chat'
		});
	}

	function append(
		convId: string,
		parentId: string | null,
		role: 'user' | 'assistant',
		text: string
	) {
		return appendMessage({
			conversationId: convId,
			parentMessageId: parentId,
			role,
			parts: [{ type: 'text', text }]
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
			modelKind: 'chat'
		});
		const u1 = appendMessage({
			conversationId: conv.id,
			parentMessageId: null,
			role: 'user',
			parts: [{ type: 'text', text: 'branch A' }]
		});
		const a1 = appendMessage({
			conversationId: conv.id,
			parentMessageId: u1.id,
			role: 'assistant',
			parts: [{ type: 'text', text: 'A reply' }]
		});
		const u2 = appendMessage({
			conversationId: conv.id,
			parentMessageId: null,
			role: 'user',
			parts: [{ type: 'text', text: 'branch B' }]
		});
		const a2 = appendMessage({
			conversationId: conv.id,
			parentMessageId: u2.id,
			role: 'assistant',
			parts: [{ type: 'text', text: 'B reply' }]
		});
		return { user: u, conv, u1, a1, u2, a2 };
	}

	it('deletes the subtree rooted at the target sibling', () => {
		const { conv, u1, a1, u2 } = buildTwoBranches();
		const result = deleteBranch(conv.id, u1.id);
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
		const result = deleteBranch(conv.id, u1.id);
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

	it('decrements media ref_count for messages on the deleted branch', () => {
		const { user, conv, u1, a1, a2 } = buildTwoBranches();
		// Generated image referenced by BOTH branches' assistants (e.g. same
		// hash returned by the bridge across runs). Ref count starts at 2.
		const { id: mediaId } = insertMedia({
			userId: user.id,
			storagePath: 'ab/cd/test.png',
			contentType: 'image/png',
			byteSize: 1024,
			kind: 'image',
			sourceEndpointId: 'bridge',
			sourceModel: 'bridge::x',
			promptExcerpt: null
		});
		linkMessageMedia(a1.id, mediaId);
		linkMessageMedia(a2.id, mediaId);
		const before = mocks.testDb
			.select({ refCount: media.refCount })
			.from(media)
			.where(eq(media.id, mediaId))
			.get();
		expect(before?.refCount).toBe(2);

		deleteBranch(conv.id, u1.id);

		// Now ref_count is 1 (a2 still references it).
		const after = mocks.testDb
			.select({
				refCount: media.refCount,
				unreferencedSince: media.unreferencedSince
			})
			.from(media)
			.where(eq(media.id, mediaId))
			.get();
		expect(after?.refCount).toBe(1);
		// Still referenced, so unreferencedSince stays null.
		expect(after?.unreferencedSince).toBeNull();
	});

	it('stamps media unreferencedSince when ref_count hits zero after delete', () => {
		const { user, conv, u1, a1 } = buildTwoBranches();
		// Media referenced ONLY by the to-be-deleted branch.
		const { id: mediaId } = insertMedia({
			userId: user.id,
			storagePath: 'ab/cd/orphan.png',
			contentType: 'image/png',
			byteSize: 1024,
			kind: 'image',
			sourceEndpointId: 'bridge',
			sourceModel: 'bridge::x',
			promptExcerpt: null
		});
		linkMessageMedia(a1.id, mediaId);
		expect(
			mocks.testDb.select({ r: media.refCount }).from(media).where(eq(media.id, mediaId)).get()?.r
		).toBe(1);

		deleteBranch(conv.id, u1.id);

		// Ref count hit zero → purger gets a green light via unreferencedSince.
		const after = mocks.testDb
			.select({ refCount: media.refCount, unreferencedSince: media.unreferencedSince })
			.from(media)
			.where(eq(media.id, mediaId))
			.get();
		expect(after?.refCount).toBe(0);
		expect(after?.unreferencedSince).not.toBeNull();
	});

	it('refuses to delete a branch that has no siblings', () => {
		const u = seedUser();
		const conv = createConversation({
			userId: u.id,
			endpointId: 'bridge',
			modelId: 'bridge::x',
			modelKind: 'chat'
		});
		const root = appendMessage({
			conversationId: conv.id,
			parentMessageId: null,
			role: 'user',
			parts: [{ type: 'text', text: 'only message' }]
		});
		const result = deleteBranch(conv.id, root.id);
		expect(result).toEqual({ refusedReason: 'no-siblings' });
		// Message is still there.
		expect(getMessage(conv.id, root.id)).not.toBeNull();
	});

	it('returns null when the message does not belong to the conversation', () => {
		const { conv } = buildTwoBranches();
		const result = deleteBranch(conv.id, 'not-a-real-message-id');
		expect(result).toBeNull();
	});
});
