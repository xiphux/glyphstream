/** Small string helpers shared across client and server code. */

/**
 * Truncate `s` to at most `max` characters, replacing the cut-off tail
 * with a single ellipsis. A string already within `max` is returned
 * unchanged. Trailing whitespace before the ellipsis is trimmed so the
 * result never reads as "word …".
 */
export function truncateEllipsis(s: string, max: number): string {
	if (s.length <= max) return s;
	return s.slice(0, max - 1).trimEnd() + '…';
}
