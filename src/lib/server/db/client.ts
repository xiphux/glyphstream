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
	// Negative values are KiB rather than pages; -64000 = ~64 MiB of page
	// cache. Default is 2 MiB, which on a busy install fills up fast and
	// pushes the working set out to disk on every chat-page load.
	sqlite.pragma('cache_size = -64000');
	// 30 MiB of memory-mapped I/O lets SQLite skip the syscall path on
	// reads that hit the mapping. Cheap on 64-bit; effectively free when
	// the file is small enough to fit, no harm when it isn't.
	sqlite.pragma('mmap_size = 30000000');

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
