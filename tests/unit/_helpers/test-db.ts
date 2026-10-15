/**
 * Per-test SQLite + Drizzle setup. Each call to `createTestDb()` opens
 * a fresh `:memory:` database, applies the project's migrations, and
 * installs it as what `getDb()` returns (`setDbForTests`), so the real
 * query helpers run against it with no mock of `#lib/server/db/client.js`.
 *
 * Pattern in test files:
 *
 *   beforeEach(() => { createTestDb(); });
 *   afterEach(() => closeTestDb());
 *
 * Keep the returned handle when the test queries the database itself.
 * Without either, `getDb()` throws under vitest rather than opening the
 * on-disk database.
 *
 * In-memory + foreign_keys ON. WAL is *off* (in-memory + WAL doesn't
 * work); synchronous=OFF is fine because there's no durability target.
 */

import { DatabaseSync } from 'node:sqlite';
import { drizzle, type NodeSQLiteDatabase } from 'drizzle-orm/node-sqlite';
import { migrate } from 'drizzle-orm/node-sqlite/migrator';
import { resolve } from 'node:path';
import { setDbForTests } from '../../../src/lib/server/db/client';
export type TestDB = NodeSQLiteDatabase;

let active: { db: TestDB; sqlite: DatabaseSync } | null = null;

export function createTestDb(): TestDB {
	closeTestDb();
	const sqlite = new DatabaseSync(':memory:');
	sqlite.exec('PRAGMA foreign_keys = ON');
	sqlite.exec('PRAGMA synchronous = OFF');
	const db = drizzle({ client: sqlite });
	migrate(db, { migrationsFolder: resolve('./drizzle') });
	active = { db, sqlite };
	setDbForTests(db);
	return db;
}

export function closeTestDb(): void {
	if (active) {
		setDbForTests(null);
		active.sqlite.close();
		active = null;
	}
}

export function activeTestDb(): TestDB {
	if (!active) throw new Error('No test DB active — call createTestDb() first');
	return active.db;
}
