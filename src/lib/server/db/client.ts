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

	// Collect planner statistics. Without `sqlite_stat1` every index is costed
	// from hardcoded defaults, which is how a two-equality-column index kept
	// getting picked over the one that actually narrows the rows — the planner
	// had no way to know `origin = 'generated'` matches nearly the whole table
	// while `user_id` matches a fraction of it.
	//
	// `optimize = 0x10012` rather than a bare `PRAGMA optimize`, because this
	// connection is memoized for the life of the process. Bare optimize only
	// *refreshes* stats for tables the connection has already queried — and here,
	// right after migrate(), nothing has been. It does still write stats for
	// never-analyzed tables, which is why the first open populates them: without
	// 0x10000 the numbers then freeze at whatever the DB looked like the first
	// time it was opened non-empty, for the life of the process and across every
	// restart after it. On a fresh install that's a handful of rows, and stale
	// tiny stats can be worse than no stats at all: on the real
	// schema at 30k media, a frozen 5-row snapshot was measured re-planning both
	// `listMediaNeedingEmbedding` and the purger's sweep from index seeks to
	// `SCAN media`, defeating the two partial indexes added to serve them — while
	// with no stats at all the planner picked those indexes correctly. Whether a
	// given frozen snapshot actually flips a plan depends on the ratios it
	// captured, so don't expect every install to show it; the point is that the
	// numbers stop tracking the data at all.
	//   0x10000 — consider every table, not just ones this connection has used.
	//   0x00010 — bound each ANALYZE with a temporary analysis_limit. On by
	//             default for a bare `optimize`, but an explicit mask clears every
	//             bit it doesn't name, so it has to be restated: leaving it off
	//             scans every row instead of sampling 2001 per index (6.1ms vs
	//             2.2ms at 30k media).
	//   0x00002 — actually run ANALYZE.
	// SQLite re-analyzes a table only once its row count has moved ~10x since the
	// last run, so steady-state boots stay a ~0.04ms no-op.
	sqlite.exec('PRAGMA optimize = 0x10012');

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
