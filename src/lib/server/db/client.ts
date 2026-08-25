import { DatabaseSync } from 'node:sqlite';
import { drizzle, type NodeSQLiteDatabase } from 'drizzle-orm/node-sqlite';
import { migrate } from 'drizzle-orm/node-sqlite/migrator';
import { existsSync, mkdirSync, statSync } from 'node:fs';
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

/** Effective `mmap_size` after the PRAGMA, read back at open. See mmapBytes(). */
let effectiveMmapBytes: number | null = null;

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
	// Map the whole database, with room to grow. SQLite's own default is 0 —
	// mmap OFF entirely (`DEFAULT_MMAP_SIZE=0` in node's build) — so any value
	// here is ours, and the previous 30MB was not a considered ceiling. It had
	// become one: a production database measured at 40.6MB served its last
	// quarter through `read(2)`, which is the worst shape for this deployment.
	//
	// The distinction that matters is not syscall-vs-no-syscall, it's WHICH KIND
	// of memory holds the pages. Mapped pages are file-backed and clean, so a
	// host under pressure reclaims them for free and a later read faults one
	// page back off the volume. Pages read through `read(2)` land in SQLite's
	// own heap cache — anonymous memory, which can only be reclaimed by writing
	// it to SWAP and can only be recovered by reading it back. On a NAS sharing
	// RAM with other containers, that difference is the whole cost of an idle
	// container's next request.
	//
	// The ceiling is a compile-time `MAX_MMAP_SIZE=0x7fff0000` (~2GB), which
	// silently CLAMPS rather than erroring, so the effective value is read back
	// below rather than assumed. Sharp edges worth knowing, both of them the
	// reason SQLite ships this off by default:
	//   - A read error on a mapped page raises SIGBUS and kills the process,
	//     where `read(2)` would have returned SQLITE_IOERR for SQLite to handle.
	//   - The file is writable through the process's address space, so a stray
	//     pointer can corrupt the database rather than a heap copy of it.
	// Neither is new here: 30MB was already mapped, and it held the hot pages.
	// This widens existing exposure rather than opening a new kind. It does
	// assume the database is on a LOCAL filesystem — mmap over NFS/SMB is not
	// reliable, so a DB_PATH pointing at a mounted share wants this back at 0.
	sqlite.exec('PRAGMA mmap_size = 268435456');

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

	// Read the mapping back rather than trusting the write. `mmap_size` clamps
	// silently at the compile-time maximum, and a build with mmap disabled
	// accepts the PRAGMA and keeps 0 — so the number we asked for says nothing
	// about the number in force. The debug panel reports THIS one.
	const row = sqlite.prepare('PRAGMA mmap_size').all()[0] as { mmap_size?: number } | undefined;
	effectiveMmapBytes = typeof row?.mmap_size === 'number' ? row.mmap_size : null;

	cached = { db, sqlite };
	return db;
}

/** Effective `mmap_size` in bytes, as SQLite reported it after the PRAGMA —
 *  null before the first `getDb()`, or where the pragma returned no row. */
export function mmapBytes(): number | null {
	return effectiveMmapBytes;
}

/**
 * On-disk size of the database and its write-ahead log.
 *
 * Reported by the debug panel so "is the file past the mapping?" is a reading
 * rather than an inference — the question that decides whether reads are being
 * served from the mapping or through `read(2)`, and one nothing else in the
 * panel can answer. The WAL is separate because it is never mapped at all: WAL
 * frames always go through `read(2)`, so a log that has grown large is read
 * traffic the major-fault counter cannot see, for the same reason a database
 * past the cap is.
 *
 * Both are `statSync` calls on the request path. Cheap (a stat, not a read) and
 * gated to signed-in document responses, but not free — if this ever needs to
 * run per-API-request, cache it behind a clock.
 */
export function dbFileBytes(): { main: number | null; wal: number | null } {
	const path = resolve(dbPath());
	const size = (p: string): number | null => {
		try {
			return statSync(p).size;
		} catch {
			// Absent WAL is the normal case between checkpoints, not an error.
			return null;
		}
	};
	return { main: size(path), wal: size(`${path}-wal`) };
}

/** Close the SQLite connection (test/teardown only). */
export function closeDb(): void {
	if (cached) {
		cached.sqlite.close();
		cached = null;
	}
}
