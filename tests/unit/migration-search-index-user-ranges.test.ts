/**
 * `*_search_index_user_ranges` renumbers `search_index` so each user's rows sit
 * in their own rowid range, which is what lets a search seek past every other
 * user's matches. Two things have to hold for that to be safe:
 *
 *   - The rebuild loses nothing and changes no result: on a populated database
 *     every searchable row survives with the same text, and the pre-migration
 *     query returns the same conversations, ranks and snippets afterwards.
 *   - Every row the triggers write afterwards lands in its owner's range, or
 *     the range filter would hide it from its owner.
 *
 * Trigger correctness in general (ref rows, rename, delete) is held by
 * db-search-index-ref.test.ts, which runs against the migrated schema.
 */
import { cpSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { drizzle, type NodeSQLiteDatabase } from 'drizzle-orm/node-sqlite';
import { migrate } from 'drizzle-orm/node-sqlite/migrator';
import { sql } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { setDbForTests } from '../../src/lib/server/db/client';
import { closeTestDb, createTestDb } from './_helpers/test-db';
import { seedUser } from './_helpers/seed';
import {
	createConversation,
	deleteConversation,
	renameConversation,
	setConversationSummary,
} from '#lib/server/db/queries/conversations.js';
import { appendMessage, updateMessageParts } from '#lib/server/db/queries/messages.js';
import { buildFtsQuery, searchConversations } from '#lib/server/db/queries/search.js';

const MIGRATIONS = resolve('./drizzle');
const all = readdirSync(MIGRATIONS, { withFileTypes: true })
	.filter((e) => e.isDirectory())
	.map((e) => e.name)
	.sort();
const THIS = all.findIndex((d) => d.endsWith('_search_index_user_ranges'));
if (THIS < 0) throw new Error('search_index_user_ranges migration directory not found');

const RANGE = 2 ** 32;
const QUERIES = ['the', 'python', 'dragon', 'loop', 'python loop', 'summary', 'title'];

interface Hit {
	conversation_id: string;
	kind: string;
	message_id: string | null;
	best: number;
	snippet: string;
}

/** The search as it ran before the migration: owner filtered by `s.user_id`. */
function legacySearch(db: NodeSQLiteDatabase, userId: string, raw: string): Hit[] {
	const match = buildFtsQuery(raw)!;
	const best = db.all<{ rid: number; best: number }>(sql`
		SELECT s.rowid AS rid, MIN(s.rank) AS best, c.updated_at
		FROM search_index s JOIN conversations c ON c.id = s.conversation_id
		WHERE s.user_id = ${userId} AND search_index MATCH ${match}
		GROUP BY s.conversation_id ORDER BY best ASC, c.updated_at DESC LIMIT 30
	`);
	return best.map(({ rid, best: score }) => {
		const [row] = db.all<Omit<Hit, 'best'>>(sql`
			SELECT conversation_id, kind, message_id,
				snippet(search_index, 0, '[', ']', '…', 32) AS snippet
			FROM search_index WHERE search_index MATCH ${match} AND rowid = ${BigInt(rid)}
		`);
		return { ...row, best: score };
	});
}

const indexedRows = (db: NodeSQLiteDatabase) =>
	db.all<{ kind: string; conversation_id: string; message_id: string | null; text: string }>(sql`
		SELECT kind, conversation_id, message_id, text, user_id FROM search_index
		ORDER BY kind, conversation_id, message_id
	`);

/** Every row is in its owner's range and has its ref row. */
function assertRowsInOwnerRanges(db: NodeSQLiteDatabase) {
	const stray = db.all(sql`
		SELECT s.rowid, s.user_id FROM search_index s
		LEFT JOIN search_index_owner o ON o.user_id = s.user_id
		WHERE o.ord IS NULL OR s.rowid NOT BETWEEN o.ord * ${RANGE} + 1 AND o.ord * ${RANGE} + ${RANGE - 1}
	`);
	expect(stray, 'rows outside their owner range').toEqual([]);
	const unreferenced = db.all(sql`
		SELECT s.rowid FROM search_index s
		LEFT JOIN search_index_ref r ON r.fts_rowid = s.rowid WHERE r.fts_rowid IS NULL
	`);
	expect(unreferenced, 'rows with no ref').toEqual([]);
	const [{ refs }] = db.all<{ refs: number }>(sql`SELECT count(*) AS refs FROM search_index_ref`);
	const [{ rows }] = db.all<{ rows: number }>(sql`SELECT count(*) AS rows FROM search_index`);
	expect(refs).toBe(rows);
}

function conv(userId: string, title: string | null) {
	return createConversation({
		userId,
		endpointId: 'e',
		modelId: 'e::m',
		modelKind: 'chat',
		...(title != null ? { title } : {}),
	});
}

function say(conversationId: string, parent: string | null, text: string) {
	return appendMessage({
		conversationId,
		parentMessageId: parent,
		role: 'user',
		parts: [{ type: 'text', text }],
	}).id;
}

const WORDS = ['the', 'python', 'dragon', 'loop', 'cache', 'river', 'lamp', 'summary', 'title'];

/** Two users' conversations, written interleaved so their old rowids mix. */
function populate(a: string, b: string) {
	let n = 0;
	const text = (k: number) =>
		Array.from({ length: 3 + (k % 7) }, (_, i) => WORDS[(k * 7 + i * 3) % WORDS.length]).join(' ');
	const convs = [a, b, a, b, a].map((u, i) => ({ u, id: conv(u, `title ${WORDS[i]}`).id }));
	const parents = new Map<string, string | null>();
	for (let round = 0; round < 6; round++) {
		for (const c of convs) {
			const id = say(c.id, parents.get(c.id) ?? null, text(n++));
			parents.set(c.id, id);
		}
	}
	setConversationSummary(convs[0].id, 'a summary about python loops', Date.now());
	setConversationSummary(convs[1].id, 'a summary about the dragon', Date.now());
	// Another user's id in message text is just text.
	say(convs[1].id, parents.get(convs[1].id)!, `mention ${a} python`);
	const untitled = conv(b, null);
	say(untitled.id, null, 'dragon loop');
}

describe('the rebuild on a populated database', () => {
	const staging = mkdtempSync(join(tmpdir(), 'gs-search-ranges-'));
	afterEach(() => {
		setDbForTests(null);
		rmSync(staging, { recursive: true, force: true });
	});

	it('keeps every searchable row and every result', () => {
		const folder = join(staging, 'drizzle');
		mkdirSync(folder, { recursive: true });
		for (const dir of all.slice(0, THIS))
			cpSync(join(MIGRATIONS, dir), join(folder, dir), { recursive: true });
		const sqlite = new DatabaseSync(':memory:');
		sqlite.exec('PRAGMA foreign_keys = ON');
		const db = drizzle({ client: sqlite });
		migrate(db, { migrationsFolder: folder });
		setDbForTests(db);

		const [a, b] = [randomUUID(), randomUUID()];
		for (const id of [a, b]) {
			db.run(sql`INSERT INTO users (id, created_at) VALUES (${id}, ${Date.now()})`);
		}
		populate(a, b);
		const rowsBefore = indexedRows(db);
		const before = Object.fromEntries(
			[a, b].flatMap((u) => QUERIES.map((q) => [`${u}/${q}`, legacySearch(db, u, q)])),
		);
		expect(before[`${a}/python`].length).toBeGreaterThan(1);

		for (const dir of all.slice(THIS))
			cpSync(join(MIGRATIONS, dir), join(folder, dir), { recursive: true });
		migrate(db, { migrationsFolder: folder });

		expect(indexedRows(db)).toEqual(rowsBefore);
		assertRowsInOwnerRanges(db);
		for (const u of [a, b]) {
			for (const q of QUERIES) {
				const expected = before[`${u}/${q}`];
				expect(legacySearch(db, u, q), `${q}: ranks and snippets`).toEqual(expected);
				expect(
					searchConversations(u, q).map((r) => [r.conversationId, r.kind, r.messageId]),
					`${q}: the range-scoped search`,
				).toEqual(expected.map((h) => [h.conversation_id, h.kind, h.message_id]));
			}
		}
		sqlite.close();
	});
});

describe('after the migration', () => {
	afterEach(() => closeTestDb());

	it('writes every new row into its owner range, through every trigger', () => {
		const db = createTestDb();
		const a = seedUser().id;
		const b = seedUser().id;
		const ca = conv(a, 'Quince orchard');
		const cb = conv(b, 'Quince jam');
		const ma = say(ca.id, null, 'quince pruning');
		say(cb.id, null, 'quince pectin');
		assertRowsInOwnerRanges(db);

		updateMessageParts(ma, ca.id, [{ type: 'text', text: 'medlar pruning' }]);
		renameConversation(cb.id, b, 'Medlar jam');
		setConversationSummary(ca.id, 'orchard medlar notes', Date.now());
		setConversationSummary(ca.id, null, Date.now());
		assertRowsInOwnerRanges(db);

		expect(searchConversations(a, 'quince').map((r) => r.kind)).toEqual(['title']);
		expect(searchConversations(a, 'medlar').map((r) => r.messageId)).toEqual([ma]);
		expect(searchConversations(b, 'medlar').map((r) => r.conversationId)).toEqual([cb.id]);
		expect(searchConversations(b, 'pruning')).toEqual([]);

		deleteConversation(ca.id, a);
		assertRowsInOwnerRanges(db);
		expect(searchConversations(a, 'medlar')).toEqual([]);
		expect(searchConversations(b, 'medlar')).toHaveLength(1);
	});

	it("never returns another user's rows, even for a query naming their id", () => {
		createTestDb();
		const a = seedUser().id;
		const b = seedUser().id;
		say(conv(a, 'shared words').id, null, `shared words ${b}`);
		say(conv(b, 'shared words').id, null, `shared words ${a}`);
		const mine = searchConversations(a, 'shared');
		expect(mine).toHaveLength(1);
		expect(searchConversations(a, b)).toHaveLength(1);
		expect(searchConversations(a, a)).toEqual([]);
		expect(searchConversations(seedUser().id, 'shared'), 'a user with no rows').toEqual([]);
	});
});
