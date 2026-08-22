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
 * Accumulated on `locals` rather than returned, because the loads that matter
 * run in two places (the `(app)` layout and the page) and the value is stamped
 * by the hook after both have finished.
 *
 * COVERAGE, since this is opt-in per call site and the reported number is only
 * as honest as its scope. Instrumented: the `(app)` layout, and `chat/[id]`.
 * Between them those cover the two readings the panel exists for — an iOS cold
 * launch, which lands on `start_url: '/'` where the page load itself does no DB
 * work, and a hard-loaded conversation. Every other route therefore reports the
 * layout's share alone; that is stated in docs/deployment.md rather than left
 * for a reader to discover.
 *
 * The remaining loads are uninstrumented for two different reasons, and it is
 * worth not blurring them. Most (`archived`, and the `settings/*` pages) await
 * nothing but `parent()` and are a one-line `timeDb` away — they are simply not
 * done, on the grounds that the panel reads the DOCUMENT navigation entry, so a
 * client-side navigation to one of those routes shows the launch document's
 * numbers anyway and only a hard reload would consult its own.
 *
 * The gallery's search path is the one that needs thought rather than typing.
 * `searchMediaForUser` is `async`, but its expensive legs — the FTS5 rank and a
 * scan of up to `DENSE_CORPUS_CAP` stored embedding blobs — are synchronous, and
 * are exactly the blocked-loop case this metric exists to surface. Reaching them
 * means threading request identity into a query module that has none. Note this
 * helper could not have gone wrong by simply wrapping the outer call: it takes a
 * SYNCHRONOUS callback and never awaits, so timing an async function would
 * measure its prefix and quietly report near-zero — a useless number, not a
 * misleading one made of network latency.
 *
 * A central alternative was considered and rejected: drizzle v1's `logQuery` is
 * fire-and-forget with no completion callback, so covering everything would take
 * AsyncLocalStorage plus a proxy on `DatabaseSync.prepare` — `getDb()` is a
 * process-wide singleton with no request identity — and it would start counting
 * the background sweepers this deliberately excludes.
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
