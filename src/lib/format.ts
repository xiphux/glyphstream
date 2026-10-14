/**
 * Display formatting shared by client pages. Client-safe: no server imports.
 */

/**
 * A short calendar date for list rows: "Mar 4", or "Mar 4, 2025" outside the
 * current year. In the viewer's locale and time zone.
 */
export function formatShortDate(ms: number, now: Date = new Date()): string {
	const d = new Date(ms);
	return d.toLocaleDateString(undefined, {
		month: 'short',
		day: 'numeric',
		year: d.getFullYear() === now.getFullYear() ? undefined : 'numeric',
	});
}

/** A byte count for a file's size: "512 B", "4.2 KB", "38 KB", "1.6 MB". One
 *  decimal place where a whole number would round away most of the value. */
export function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) {
		const kb = bytes / 1024;
		return `${kb.toFixed(kb < 10 ? 1 : 0)} KB`;
	}
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
