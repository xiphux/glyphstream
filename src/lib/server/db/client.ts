import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { dbPath } from '../env';
import * as schema from './schema';

export type DB = BetterSQLite3Database<typeof schema>;

let cached: { db: DB; sqlite: Database.Database } | null = null;

/**
 * Open (and memoize) the SQLite connection. PRAGMAs are set on first open;
 * pending migrations are applied automatically.
 */
export function getDb(): DB {
	if (cached) return cached.db;

	const path = resolve(dbPath());
	mkdirSync(dirname(path), { recursive: true });

	const sqlite = new Database(path);
	sqlite.pragma('journal_mode = WAL');
	sqlite.pragma('synchronous = NORMAL');
	sqlite.pragma('busy_timeout = 5000');
	sqlite.pragma('foreign_keys = ON');

	const db = drizzle(sqlite, { schema });

	if (existsSync(resolve('./drizzle'))) {
		migrate(db, { migrationsFolder: resolve('./drizzle') });
	}

	cached = { db, sqlite };
	return db;
}

/** Close the SQLite connection (test/teardown only). */
export function closeDb(): void {
	if (cached) {
		cached.sqlite.close();
		cached = null;
	}
}
