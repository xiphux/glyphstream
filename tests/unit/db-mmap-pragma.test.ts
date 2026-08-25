/**
 * The platform assumptions under `PRAGMA mmap_size` in db/client.ts.
 *
 * This is a test about node's BUNDLED SQLITE, not about our code — which is the
 * point. The pragma is a single line whose whole value rests on facts we cannot
 * see from the call site and that a Node upgrade could change silently:
 *
 *   - mmap has to be compiled IN. `SQLITE_MAX_MMAP_SIZE=0` disables it, and a
 *     build with it off still ACCEPTS the pragma and keeps 0. Nothing errors.
 *   - The requested size has to survive. It clamps at the compile-time maximum
 *     rather than failing, so asking for more than the ceiling silently gives
 *     you the ceiling.
 *   - The readback has to work, since client.ts reports the effective value to
 *     the debug panel rather than the requested one. `PRAGMA mmap_size` returns
 *     no rows at all on an in-memory database (there is no file to map), so the
 *     shape only holds for a file-backed connection.
 *
 * If any of those changes, the mapping quietly stops happening and the symptom
 * is a slow production box — a database serving reads through `read(2)` looks
 * exactly like one that is simply cold, and the fault counter cannot tell them
 * apart. That is the failure this file is here to convert into a red test.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** What client.ts asks for. Restated rather than imported: importing it would
 *  pull in `$env/dynamic/private` through env.ts, and the constant is the
 *  subject here, not a dependency. */
const REQUESTED = 268_435_456; // 256 MiB

let dir: string | null = null;

function fileDb(): DatabaseSync {
	dir = mkdtempSync(join(tmpdir(), 'gs-mmap-'));
	const db = new DatabaseSync(join(dir, 'probe.db'));
	// A mapping needs something to map; an empty file has no pages.
	db.exec('CREATE TABLE t(a)');
	return db;
}

afterEach(() => {
	if (dir) rmSync(dir, { recursive: true, force: true });
	dir = null;
});

/** The readback client.ts performs, in the shape client.ts performs it. */
function readMmap(db: DatabaseSync): number | undefined {
	const row = db.prepare('PRAGMA mmap_size').all()[0] as { mmap_size?: number } | undefined;
	return row?.mmap_size;
}

describe('PRAGMA mmap_size on node:sqlite', () => {
	it('is compiled in, so the pragma can do anything at all', () => {
		const db = fileDb();
		const opts = db
			.prepare(
				"SELECT group_concat(compile_options) o FROM pragma_compile_options WHERE compile_options LIKE 'MAX_MMAP_SIZE=%'",
			)
			.get() as { o: string | null };
		// Present AND nonzero. `MAX_MMAP_SIZE=0` is the disabled build, and it
		// would still pass a bare "is the option present" check.
		expect(opts.o).toMatch(/^MAX_MMAP_SIZE=/);
		expect(opts.o).not.toBe('MAX_MMAP_SIZE=0');
		db.close();
	});

	it('defaults to 0 — the 256MB in client.ts is ours, not a SQLite default', () => {
		// Worth stating explicitly because the natural reading of a nondefault
		// number is that SQLite chose a conservative one for a reason. It didn't
		// choose one: upstream ships mmap OFF, so there is no default to defer to
		// and no ceiling being overridden.
		const db = fileDb();
		expect(readMmap(db)).toBe(0);
		db.close();
	});

	it('holds the size client.ts requests, rather than clamping it away', () => {
		const db = fileDb();
		db.exec(`PRAGMA mmap_size = ${REQUESTED}`);
		expect(readMmap(db)).toBe(REQUESTED);
		db.close();
	});

	it('clamps silently above the ceiling, which is why the value is read back', () => {
		// The behaviour that makes reporting the REQUESTED value a lie. Asking for
		// 8GB succeeds, returns no error, and leaves ~2GB in force.
		const db = fileDb();
		db.exec('PRAGMA mmap_size = 8000000000');
		const effective = readMmap(db)!;
		expect(effective).toBeGreaterThan(0);
		expect(effective).toBeLessThan(8_000_000_000);
		// And the ceiling is comfortably above what we ask for, so the request
		// above isn't landing on a clamp by coincidence.
		expect(effective).toBeGreaterThanOrEqual(REQUESTED);
		db.close();
	});

	it('returns no row for an in-memory database, so the readback needs a file', () => {
		// Guards the shape of client.ts's optional-chained readback. An in-memory
		// connection has nothing to map and `.all()` comes back EMPTY rather than
		// returning a zero — so indexing [0] unguarded would throw, and this is the
		// connection every test in the suite uses.
		const mem = new DatabaseSync(':memory:');
		expect(mem.prepare('PRAGMA mmap_size').all()).toEqual([]);
		expect(readMmap(mem)).toBeUndefined();
		mem.close();
	});
});
