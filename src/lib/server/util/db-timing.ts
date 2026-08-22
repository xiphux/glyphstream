/**
 * How much of a request's render phase was spent inside SQLite.
 *
 * `render` is the biggest span the panel reports and the least specific: it
 * covers the load functions and the Svelte render together, and a slow one has
 * been read as "the box is cold", "the page is big" and "a query is slow" at
 * various times with no way to choose between them.
 *
 * The question is sharper than it looks on this deployment. `node:sqlite` is
 * synchronous, so a read that misses the page cache blocks the event loop for
 * the length of the physical I/O — and only PART of that shows up in the major
 * fault counter. `db/client.ts` maps the first 30MB of the file; a database past
 * that size serves its tail through `read(2)`, which bills to wall time and
 * registers no fault at all. A production database measured at 40.6MB — a
 * quarter of it beyond the mapping — with a 2.2s stall that only 200 faults
 * could not account for. This span is what tells those apart.
 *
 * Accumulated on `locals` rather than returned, because more than one load runs
 * per request and the hook stamps the total after all of them finish.
 *
 * TWO PROPERTIES A READER NEEDS, both true of this file alone:
 *
 * 1. Coverage is opt-in per call site, so the reported number is a FLOOR, not a
 *    total — a request can touch the database in places nothing here counts.
 *    `grep -rn timeDb src/routes` is the current answer to "what's covered";
 *    earlier revisions of this comment kept an inventory of other files and kept
 *    being wrong about it.
 *
 * 2. The callback is SYNCHRONOUS and this never awaits, so it measures exactly
 *    the work before the wrapped function's first `await`. For an async function
 *    that can be anything from all of it to none — `searchMediaForUser` does its
 *    whole FTS5 rank first and, without `[embeddings]` configured, returns
 *    without awaiting at all. So wrapping one does not fold in its network time,
 *    but it does risk reporting a partial as though it were the whole call.
 *
 * No central alternative to reach for: drizzle v1's `logQuery` is fire-and-forget
 * with no completion hook, so covering everything would take AsyncLocalStorage
 * plus a proxy on `DatabaseSync.prepare` — `getDb()` is a process-wide singleton
 * with no request identity — and would start counting the background sweepers
 * this deliberately excludes.
 */

/** Run a synchronous query, adding its duration to this request's total. */
export function timeDb<T>(locals: App.Locals, query: () => T): T {
	const started = performance.now();
	try {
		return query();
	} finally {
		locals.dbMs = (locals.dbMs ?? 0) + (performance.now() - started);
	}
}
