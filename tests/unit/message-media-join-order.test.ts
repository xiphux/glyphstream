/**
 * The message_media ⋈ media reads must drive from the listed messages, not
 * from the user's whole library. Without sqlite_stat1 (every fresh database,
 * and any test DB) SQLite otherwise picks media-first: one probe per media row
 * per listed message id, seconds on a long conversation. The good plan is a few
 * ms, so the bounds here have a wide margin.
 */
import { afterEach, beforeEach, expect, it } from 'vitest';
import { createTestDb, closeTestDb, activeTestDb } from './_helpers/test-db';
import { sql } from 'drizzle-orm';
import { collectConversationFiles } from '#lib/server/code-interpreter/files.js';
import { deleteConversation } from '#lib/server/db/queries/conversations.js';
import { countOrphanMediaInConversation } from '#lib/server/db/queries/media.js';

const MEDIA = 8000;
const MESSAGES = 500;

beforeEach(() => {
	const db = createTestDb();
	const now = Date.now();
	db.run(sql`INSERT INTO users (id, created_at, role) VALUES ('u', ${now}, 'user')`);
	db.run(
		sql`INSERT INTO conversations (id, user_id, endpoint_id, model_id, created_at, updated_at) VALUES ('c', 'u', 'e', 'e::m', ${now}, ${now}), ('other', 'u', 'e', 'e::m', ${now}, ${now})`,
	);
	db.run(sql`
		WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < ${MESSAGES - 1})
		INSERT INTO messages (id, conversation_id, parent_message_id, role, content_json, created_at)
		SELECT 'm' || i, 'c', CASE WHEN i = 0 THEN NULL ELSE 'm' || (i - 1) END,
			CASE WHEN i % 2 = 0 THEN 'user' ELSE 'assistant' END, '[]', ${now} + i FROM n`);
	db.run(
		sql`INSERT INTO messages (id, conversation_id, role, content_json, created_at) VALUES ('o0', 'other', 'user', '[]', ${now})`,
	);
	db.run(
		sql`UPDATE conversations SET active_leaf_message_id = ${'m' + (MESSAGES - 1)} WHERE id = 'c'`,
	);
	db.run(sql`
		WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < ${MEDIA - 1})
		INSERT INTO media (id, user_id, storage_path, content_type, byte_size, kind, created_at, ref_count, origin)
		SELECT 'med' || i, 'u', 'p/' || i, 'image/png', 10, 'image', ${now} + i, 1, 'generated' FROM n`);
	// 20 of the user's media are in the long conversation; the rest live elsewhere.
	db.run(sql`
		INSERT INTO message_media (message_id, media_id)
		SELECT CASE WHEN CAST(substr(id, 4) AS INTEGER) < 20 THEN 'm' || (CAST(substr(id, 4) AS INTEGER) * 2 + 1) ELSE 'o0' END, id FROM media`);
});
afterEach(() => closeTestDb());

it("collectConversationFiles (every run_python call) does not scale with the user's whole library", async () => {
	const t0 = performance.now();
	await collectConversationFiles('c', 'u');
	const ms = performance.now() - t0;
	expect(ms).toBeLessThan(250);
});

it("deleteConversation({ deleteMedia: true }) does not scale with the user's whole library", () => {
	const t0 = performance.now();
	const res = deleteConversation('c', 'u', { deleteMedia: true });
	const ms = performance.now() - t0;
	expect(activeTestDb()).toBeTruthy();
	expect(res.trashedMediaIds.length).toBe(20);
	expect(ms).toBeLessThan(250);
});

it("countOrphanMediaInConversation does not scale with the user's whole library", () => {
	const t0 = performance.now();
	const counts = countOrphanMediaInConversation('c', 'u');
	const ms = performance.now() - t0;
	expect(counts).toMatchObject({ images: 20 });
	expect(ms).toBeLessThan(250);
});
