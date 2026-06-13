import { DatabaseSync } from 'node:sqlite';
import { drizzle, type NodeSQLiteDatabase } from 'drizzle-orm/node-sqlite';
import { migrate } from 'drizzle-orm/node-sqlite/migrator';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { dbPath } from '../env';
import * as schema from './schema';

export type DB = NodeSQLiteDatabase<typeof schema>;

/** The transaction handle passed to a `db.transaction((tx) => …)` callback.
 *  Helpers that must run inside a caller's transaction take this so they
 *  operate on the open transaction rather than opening their own — node:sqlite
 *  (unlike better-sqlite3) does not auto-promote a nested root-level
 *  `db.transaction()` to a SAVEPOINT, so nesting must go through the `tx`. */
export type Tx = Parameters<Parameters<DB['transaction']>[0]>[0];

let cached: { db: DB; sqlite: DatabaseSync } | null = null;

/**
 * Open (and memoize) the SQLite connection. PRAGMAs are set on first open;
 * pending migrations are applied automatically.
 */
export function getDb(): DB {
	if (cached) return cached.db;

	const path = resolve(dbPath());
	mkdirSync(dirname(path), { recursive: true });

	const sqlite = new DatabaseSync(path);
	sqlite.exec('PRAGMA journal_mode = WAL');
	sqlite.exec('PRAGMA synchronous = NORMAL');
	sqlite.exec('PRAGMA busy_timeout = 5000');
	sqlite.exec('PRAGMA foreign_keys = ON');
	// Negative values are KiB rather than pages; -64000 = ~64 MiB of page
	// cache. Default is 2 MiB, which on a busy install fills up fast and
	// pushes the working set out to disk on every chat-page load.
	sqlite.exec('PRAGMA cache_size = -64000');
	// 30 MiB of memory-mapped I/O lets SQLite skip the syscall path on
	// reads that hit the mapping. Cheap on 64-bit; effectively free when
	// the file is small enough to fit, no harm when it isn't.
	sqlite.exec('PRAGMA mmap_size = 30000000');

	const db = drizzle({ client: sqlite, schema });

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
