/**
 * Recognising SQLite constraint failures behind drizzle's error wrapping.
 *
 * Since drizzle-orm 1.0.0-rc.4, a failing sqlite query throws a
 * `DrizzleQueryError` whose message is `Failed query: <sql>\nparams: <values>`,
 * with the driver's error on `.cause`. Matching the top-level message for
 * "UNIQUE" therefore stops working — and a loose pattern can match the SQL text
 * or a bound value instead of the failure. Walk the cause chain and trust
 * SQLite's extended result code, which node:sqlite puts on `errcode`.
 */

/** SQLITE_CONSTRAINT_UNIQUE: a UNIQUE index or constraint rejected the row. */
const SQLITE_CONSTRAINT_UNIQUE = 2067;
/** SQLITE_CONSTRAINT_PRIMARYKEY: a PRIMARY KEY (rowid or not) rejected the row. */
const SQLITE_CONSTRAINT_PRIMARYKEY = 1555;

/** Cause chains are short (drizzle wraps once); the cap only guards a cycle. */
const MAX_CAUSE_DEPTH = 5;

/**
 * True when `e`, or any error in its `cause` chain, is a SQLite UNIQUE or
 * PRIMARY KEY violation. Both are "this row already exists" to callers:
 * node:sqlite reports a duplicate primary key as "UNIQUE constraint failed"
 * too, differing only in `errcode`.
 */
export function isUniqueViolation(e: unknown): boolean {
	let current: unknown = e;
	for (let depth = 0; current && depth < MAX_CAUSE_DEPTH; depth++) {
		const errcode = (current as { errcode?: unknown }).errcode;
		if (errcode === SQLITE_CONSTRAINT_UNIQUE || errcode === SQLITE_CONSTRAINT_PRIMARYKEY) {
			return true;
		}
		current = (current as { cause?: unknown }).cause;
	}
	return false;
}
