/**
 * Keeping the response header block inside a reverse proxy's buffer.
 *
 * nginx buffers an upstream's entire header block in one `proxy_buffer_size` —
 * 4096 bytes by default, which is what a Synology reverse proxy ships. Go past
 * it and nginx does not truncate or forward: it abandons the response and serves
 * its own 502 while the app logs an ordinary 200.
 *
 * The header that gets us there is SvelteKit's `Link:`, which hints one
 * modulepreload per client chunk — 46 of them, 3205 bytes, on the chat route.
 * Deleting it outright is NOT an option, and the reason is worth recording
 * because it looks like one: in this app those hints exist ONLY in the header.
 * `%sveltekit.head%` carries the two stylesheets and an inline bootstrap that
 * `import()`s the entry, and nothing else — so dropping the header leaves the
 * browser to discover 45 chunks by walking the import graph. Measured under
 * throttling, that took the count of chunks fetched by the `load` event from 17
 * to 2: `load` now fires long before the app can hydrate. Real users see a page
 * that paints and ignores them, and Playwright's `goto()` resolves on `load` and
 * starts clicking a dead document.
 *
 * So trim to fit rather than drop. The entries are in dependency order, entry
 * chunks first, so a prefix keeps the hints that unblock the most work.
 */

/** nginx's default `proxy_buffer_size`. */
export const PROXY_HEADER_BUFFER_BYTES = 4096;

/**
 * Headroom left under the buffer. Covers a `Set-Cookie` this response didn't
 * happen to carry — a session renewal adds one, and it is what spent the last
 * 20 bytes in production — plus the status line the proxy also counts.
 */
export const HEADER_BUDGET_RESERVE_BYTES = 256;

/**
 * Bytes the proxy counts that a `Response` object cannot show you: the status
 * line, and the fields Node's HTTP layer appends on the way out (`Date`,
 * `Connection`, `Keep-Alive`, and the content-length or transfer-encoding).
 * Measured at 76 on this stack; carried at 160 so a longer status line or one
 * more transport field can't quietly eat the margin.
 *
 * Getting this wrong is invisible in a unit test and only shows up as a 502 from
 * a proxy whose logs the app can't see, which is why it's a named constant
 * rather than folded into the reserve above.
 */
export const TRANSPORT_OVERHEAD_BYTES = 160;

/** What a proxy counts: `Name: value\r\n` per field, plus a terminating CRLF. */
export function headerBlockBytes(fields: Iterable<[string, string]>): number {
	let total = 2;
	for (const [name, value] of fields) total += name.length + 2 + value.length + 2;
	return total;
}

/**
 * Longest comma-joined prefix of `value` that fits in `budget` bytes, or null
 * when not even one entry does.
 *
 * Splits on ", " rather than "," because a Link value's own parameters are
 * semicolon-separated — no entry contains ", " internally, and SvelteKit joins
 * with exactly that.
 */
export function trimToBudget(value: string, budget: number): string | null {
	if (budget <= 0) return null;
	if (value.length <= budget) return value;
	const entries = value.split(', ');
	let kept = '';
	for (const entry of entries) {
		const next = kept ? `${kept}, ${entry}` : entry;
		if (next.length > budget) break;
		kept = next;
	}
	return kept || null;
}
