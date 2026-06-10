/**
 * Compose multiple AbortSignals into one. The result aborts when any input
 * aborts, propagating that input's reason. `AbortSignal.any()` is native on
 * our Node >=24 target, so we lean on it directly.
 *
 * The fast paths matter: a single present signal is returned by identity (no
 * wrapper allocation, and the caller keeps the original reason channel), and
 * zero present signals yield a never-aborting signal.
 *
 * Used wherever a long-running operation needs to honor both a caller-
 * supplied cancel signal (turn abort) and a local timeout — chat-completion
 * fetches and tool executions (web_search, fetch_url) both fit this shape.
 */
export function composeSignals(...signals: (AbortSignal | undefined)[]): AbortSignal {
	const present = signals.filter((s): s is AbortSignal => s !== undefined);
	if (present.length === 0) return new AbortController().signal;
	if (present.length === 1) return present[0];
	return AbortSignal.any(present);
}
