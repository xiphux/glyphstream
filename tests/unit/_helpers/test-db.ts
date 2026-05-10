/**
 * Per-test SQLite + Drizzle setup. Each call to `createTestDb()` opens
 * a fresh `:memory:` database, applies the project's migrations, and
 * stows the connection in a module-local slot so the
 * `$lib/server/db/client` mock can hand it back to query helpers.
 *
 * Pattern in test files:
 *
 *   const mocks = vi.hoisted(() => ({ testDb: null as TestDB | null }));
 *   vi.mock('$lib/server/db/client', () => ({
 *     getDb: () => mocks.testDb!,
 *     closeDb: () => {}
 *   }));
 *
 *   beforeEach(() => { mocks.testDb = createTestDb(); });
 *   afterEach(() => closeTestDb());
 *
 * In-memory + foreign_keys ON. WAL is *off* (in-memory + WAL doesn't
 * work); synchronous=OFF is fine because there's no durability target.
 */

import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { resolve } from 'node:path';
import * as schema from '../../../src/lib/server/db/schema';

export type TestDB = BetterSQLite3Database<typeof schema>;

let active: { db: TestDB; sqlite: Database.Database } | null = null;

export function createTestDb(): TestDB {
	closeTestDb();
	const sqlite = new Database(':memory:');
	sqlite.pragma('foreign_keys = ON');
	sqlite.pragma('synchronous = OFF');
	const db = drizzle(sqlite, { schema });
	migrate(db, { migrationsFolder: resolve('./drizzle') });
	active = { db, sqlite };
	return db;
}

export function closeTestDb(): void {
	if (active) {
		active.sqlite.close();
		active = null;
	}
}

export function activeTestDb(): TestDB {
	if (!active) throw new Error('No test DB active — call createTestDb() first');
	return active.db;
}
