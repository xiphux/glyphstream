/**
 * Unit tests for undoCompaction — reverting the most recent compaction by
 * moving the active leaf back off the summary. Real test DB (mocked getDb) so
 * the leaf move + the active-leaf gate are exercised end to end.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDb, closeTestDb, type TestDB } from './_helpers/test-db';
import { seedUser } from './_helpers/seed';

const mocks = vi.hoisted(() => ({ testDb: null as unknown as TestDB }));

vi.mock('$lib/server/db/client', () => ({
	getDb: () => mocks.testDb,
	closeDb: () => {},
}));

import { createConversation, getConversationMeta } from '$lib/server/db/queries/conversations';
import { appendMessage, walkActiveBranch } from '$lib/server/db/queries/messages';
import { undoCompaction } from '$lib/server/chat/compaction';

beforeEach(() => {
	mocks.testDb = createTestDb();
});
afterEach(() => {
	closeTestDb();
});

/** Seed user + conversation + one turn, then append a compaction summary at the
 *  leaf (advancing the active leaf to it). Returns the ids. */
function seedCompacted() {
	const u = seedUser();
	const conv = createConversation({
		userId: u.id,
		endpointId: 'bridge',
		modelId: 'bridge::mock',
		modelKind: 'chat',
	});
	const userMsg = appendMessage({
		conversationId: conv.id,
		parentMessageId: null,
		role: 'user',
		parts: [{ type: 'text', text: 'hello' }],
	});
	const leaf = appendMessage({
		conversationId: conv.id,
		parentMessageId: userMsg.id,
		role: 'assistant',
		parts: [{ type: 'text', text: 'hi there' }],
	});
	const summary = appendMessage({
		conversationId: conv.id,
		parentMessageId: leaf.id,
		role: 'assistant',
		parts: [{ type: 'text', text: 'SUMMARY' }],
		compactionResumeFromMessageId: userMsg.id,
		advanceActiveLeaf: true,
	});
	return { userId: u.id, conversationId: conv.id, userMsg, leaf, summary };
}

describe('undoCompaction', () => {
	it('reverts the active leaf to the summary’s parent, leaving the row intact', () => {
		const { userId, conversationId, leaf, summary } = seedCompacted();
		expect(getConversationMeta(conversationId, userId)?.activeLeafMessageId).toBe(summary.id);

		const result = undoCompaction(conversationId, userId);
		expect(result.status).toBe('reverted');

		// Active leaf moved back to the pre-compaction assistant message; the
		// summary is no longer on the active branch (so it serializes out)…
		const branch = walkActiveBranch(conversationId);
		expect(branch[branch.length - 1].id).toBe(leaf.id);
		expect(branch.some((m) => m.id === summary.id)).toBe(false);
		// …but the row is NOT deleted — it stays in the tree as an inactive sibling.
		expect(getConversationMeta(conversationId, userId)?.activeLeafMessageId).toBe(leaf.id);
	});

	it('is a noop when the active leaf is not a compaction summary', () => {
		const { userId, conversationId } = seedCompacted();
		// First undo reverts; a second has nothing to revert (leaf is now a plain
		// assistant message).
		expect(undoCompaction(conversationId, userId).status).toBe('reverted');
		expect(undoCompaction(conversationId, userId).status).toBe('noop');
	});

	it('is a noop once a message has been sent after the summary', () => {
		const { userId, conversationId, summary } = seedCompacted();
		// A follow-up turn parents off the summary and advances the leaf past it.
		appendMessage({
			conversationId,
			parentMessageId: summary.id,
			role: 'user',
			parts: [{ type: 'text', text: 'next' }],
			advanceActiveLeaf: true,
		});
		expect(undoCompaction(conversationId, userId).status).toBe('noop');
	});

	it('is a noop for a conversation the user doesn’t own', () => {
		const { conversationId } = seedCompacted();
		expect(undoCompaction(conversationId, 'someone-else').status).toBe('noop');
	});
});
