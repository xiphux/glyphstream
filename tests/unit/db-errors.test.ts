import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { isUniqueViolation } from '$lib/server/db/errors';

/** Run `sql` against a fresh in-memory DB and return what node:sqlite throws. */
function sqliteError(setup: string, sql: string): unknown {
	const db = new DatabaseSync(':memory:');
	try {
		db.exec('PRAGMA foreign_keys = ON');
		db.exec(setup);
		db.exec(sql);
	} catch (e) {
		return e;
	} finally {
		db.close();
	}
	throw new Error('expected the statement to fail');
}

const SCHEMA = `
	CREATE TABLE parent (id TEXT PRIMARY KEY, handle TEXT UNIQUE);
	CREATE TABLE child (id INTEGER PRIMARY KEY, parent_id TEXT NOT NULL REFERENCES parent(id));
	INSERT INTO parent VALUES ('p1', 'taken');
	INSERT INTO child VALUES (1, 'p1');
`;

/** The shape drizzle >= 1.0.0-rc.4 throws: the SQL as message, driver error as cause. */
function wrapLikeDrizzle(cause: unknown): Error {
	return new Error('Failed query: insert into "parent" ("id") values (?)\nparams: p1', { cause });
}

describe('isUniqueViolation', () => {
	it('recognises a UNIQUE column violation from node:sqlite', () => {
		expect(
			isUniqueViolation(sqliteError(SCHEMA, "INSERT INTO parent VALUES ('p2', 'taken')")),
		).toBe(true);
	});

	it('recognises a duplicate TEXT and INTEGER primary key', () => {
		expect(isUniqueViolation(sqliteError(SCHEMA, "INSERT INTO parent VALUES ('p1', 'free')"))).toBe(
			true,
		);
		expect(isUniqueViolation(sqliteError(SCHEMA, "INSERT INTO child VALUES (1, 'p1')"))).toBe(true);
	});

	it('sees through a drizzle-style wrapper to the driver error', () => {
		const inner = sqliteError(SCHEMA, "INSERT INTO parent VALUES ('p1', 'free')");
		expect(isUniqueViolation(wrapLikeDrizzle(inner))).toBe(true);
	});

	it('does not treat other constraint failures as "already exists"', () => {
		const fk = sqliteError(SCHEMA, "INSERT INTO child VALUES (2, 'missing')");
		const notNull = sqliteError(SCHEMA, 'INSERT INTO child (id) VALUES (3)');
		expect(isUniqueViolation(fk)).toBe(false);
		expect(isUniqueViolation(wrapLikeDrizzle(notNull))).toBe(false);
	});

	it('ignores "UNIQUE" in message text, where the SQL or a bound value can put it', () => {
		expect(isUniqueViolation(new Error('UNIQUE constraint failed: parent.id'))).toBe(false);
		expect(isUniqueViolation(wrapLikeDrizzle(new Error('disk I/O error')))).toBe(false);
	});

	it('handles non-errors and cyclic cause chains', () => {
		expect(isUniqueViolation(undefined)).toBe(false);
		expect(isUniqueViolation('UNIQUE')).toBe(false);
		const a: { cause?: unknown } = {};
		const b = { cause: a };
		a.cause = b;
		expect(isUniqueViolation(a)).toBe(false);
	});
});
