/**
 * `search_index_ref` maps each FTS5 rowid back to what produced it, so the
 * maintenance triggers can delete by rowid instead of scanning the whole
 * virtual table by an UNINDEXED column (52ms -> 0.004ms per delete at 200k
 * rows; a 356-message conversation delete went from ~19s to ~1.5ms).
 *
 * That speed is only safe while the mapping stays exact. A ref row that
 * outlives its FTS row is a rowid waiting to be reused, and deleting through a
 * stale mapping would silently evict *someone else's* search row — a failure
 * that never surfaces as an error, only as results quietly going missing. So
 * these tests assert the invariant directly (ref and index agree, in both
 * directions) across every trigger path rather than only asserting that search
 * still returns the right hits.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDb, closeTestDb, type TestDB } from './_helpers/test-db';
import { seedUser } from './_helpers/seed';

const mocks = vi.hoisted(() => ({ testDb: null as unknown as TestDB }));
vi.mock('$lib/server/db/client', () => ({
	getDb: () => mocks.testDb,
	closeDb: () => {},
}));

import { sql } from 'drizzle-orm';
import {
	createConversation,
	deleteConversation,
	renameConversation,
	setConversationSummary,
} from '$lib/server/db/queries/conversations';
import { appendMessage, updateMessageParts } from '$lib/server/db/queries/messages';
import { searchConversations } from '$lib/server/db/queries/search';

beforeEach(() => {
	mocks.testDb = createTestDb();
});
afterEach(() => {
	closeTestDb();
});

/** Every index row has exactly one ref row and vice versa. */
function assertRefMatchesIndex() {
	const db = mocks.testDb;
	const orphanRefs = db.all(
		sql`SELECT r.fts_rowid FROM search_index_ref r
		    LEFT JOIN search_index s ON s.rowid = r.fts_rowid
		    WHERE s.rowid IS NULL`,
	);
	expect(orphanRefs, 'ref rows pointing at a vanished FTS row').toEqual([]);

	const unreferenced = db.all(
		sql`SELECT s.rowid FROM search_index s
		    LEFT JOIN search_index_ref r ON r.fts_rowid = s.rowid
		    WHERE r.fts_rowid IS NULL`,
	);
	expect(unreferenced, 'FTS rows with no ref row (undeletable)').toEqual([]);

	// The mapping must also describe the row it points at, or a delete keyed on
	// (message_id, kind) would resolve to the wrong rowid.
	const mismatched = db.all(
		sql`SELECT s.rowid FROM search_index s
		    JOIN search_index_ref r ON r.fts_rowid = s.rowid
		    WHERE r.kind <> s.kind
		       OR r.conversation_id <> s.conversation_id
		       OR COALESCE(r.message_id, '') <> COALESCE(s.message_id, '')`,
	);
	expect(mismatched, 'ref rows describing a different row than they point at').toEqual([]);
}

function countRefs(kind: string): number {
	const rows = mocks.testDb.all<{ n: number }>(
		sql`SELECT count(*) AS n FROM search_index_ref WHERE kind = ${kind}`,
	);
	return Number(rows[0].n);
}

function newConv(userId: string, title: string) {
	return createConversation({
		userId,
		endpointId: 'bridge',
		modelId: 'bridge::m',
		modelKind: 'chat',
		title,
	});
}

describe('search_index_ref stays exact across every trigger path', () => {
	it('tracks message insert, update and delete', () => {
		const user = seedUser();
		const conv = newConv(user.id, 'Ref integrity');

		const m = appendMessage({
			conversationId: conv.id,
			parentMessageId: null,
			role: 'user',
			parts: [{ type: 'text', text: 'artichoke provenance' }],
		});
		assertRefMatchesIndex();
		expect(countRefs('message')).toBe(1);
		expect(searchConversations(user.id, 'artichoke')).toHaveLength(1);

		// Update replaces the row — the old rowid must be released, not orphaned.
		updateMessageParts(m.id, conv.id, [{ type: 'text', text: 'rutabaga provenance' }]);
		assertRefMatchesIndex();
		expect(countRefs('message'), 'update must not leave a second row behind').toBe(1);
		expect(searchConversations(user.id, 'artichoke')).toHaveLength(0);
		expect(searchConversations(user.id, 'rutabaga')).toHaveLength(1);
	});

	it('tracks title insert, rename and clear', () => {
		const user = seedUser();
		const conv = newConv(user.id, 'Kumquat');
		assertRefMatchesIndex();
		expect(countRefs('title')).toBe(1);

		renameConversation(conv.id, user.id, 'Persimmon');
		assertRefMatchesIndex();
		expect(countRefs('title'), 'rename must replace, not duplicate').toBe(1);
		expect(searchConversations(user.id, 'Kumquat')).toHaveLength(0);
		expect(searchConversations(user.id, 'Persimmon')).toHaveLength(1);
	});

	it('tracks summary write and rewrite', () => {
		const user = seedUser();
		const conv = newConv(user.id, 'Summarized');

		setConversationSummary(conv.id, 'discussed the tessellation of hexagons', Date.now());
		assertRefMatchesIndex();
		expect(countRefs('summary')).toBe(1);
		expect(searchConversations(user.id, 'tessellation')).toHaveLength(1);

		setConversationSummary(conv.id, 'discussed the migration of albatrosses', Date.now());
		assertRefMatchesIndex();
		expect(countRefs('summary'), 'rewrite must replace, not duplicate').toBe(1);
		expect(searchConversations(user.id, 'tessellation')).toHaveLength(0);
		expect(searchConversations(user.id, 'albatross')).toHaveLength(1);
	});

	it('leaves nothing behind when a whole conversation is deleted', () => {
		const user = seedUser();
		const doomed = newConv(user.id, 'Doomed thread');
		setConversationSummary(doomed.id, 'a summary that should not survive', Date.now());
		let parent: string | null = null;
		for (let i = 0; i < 5; i++) {
			parent = appendMessage({
				conversationId: doomed.id,
				parentMessageId: parent,
				role: 'user',
				parts: [{ type: 'text', text: `doomed message ${i} zzyzx` }],
			}).id;
		}

		// A second conversation whose rows must be untouched by the sweep.
		const keeper = newConv(user.id, 'Keeper thread');
		appendMessage({
			conversationId: keeper.id,
			parentMessageId: null,
			role: 'user',
			parts: [{ type: 'text', text: 'keeper message zzyzx' }],
		});
		assertRefMatchesIndex();

		deleteConversation(doomed.id, user.id);
		assertRefMatchesIndex();

		const leftovers = mocks.testDb.all(
			sql`SELECT fts_rowid FROM search_index_ref WHERE conversation_id = ${doomed.id}`,
		);
		expect(leftovers, 'deleted conversation left ref rows behind').toEqual([]);
		// The surviving conversation still matches the shared term.
		expect(searchConversations(user.id, 'zzyzx')).toHaveLength(1);
	});
});
