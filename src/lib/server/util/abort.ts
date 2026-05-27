/**
 * Compose multiple AbortSignals into one. The result aborts when any input
 * aborts. `AbortSignal.any()` exists in Node 20+ but the polyfill keeps
 * older runtimes safe and matches the same semantics.
 *
 * Used wherever a long-running operation needs to honor both a caller-
 * supplied cancel signal (turn abort) and a local timeout — chat-completion
 * fetches and tool executions (web_search, fetch_url) both fit this shape.
 */
export function composeSignals(...signals: (AbortSignal | undefined)[]): AbortSignal {
	const present = signals.filter((s): s is AbortSignal => s !== undefined);
	if (present.length === 0) return new AbortController().signal;
	if (present.length === 1) return present[0];
	if (typeof AbortSignal.any === 'function') return AbortSignal.any(present);
	const controller = new AbortController();
	for (const s of present) {
		if (s.aborted) {
			controller.abort(s.reason);
			return controller.signal;
		}
		s.addEventListener('abort', () => controller.abort(s.reason), { once: true });
	}
	return controller.signal;
}
