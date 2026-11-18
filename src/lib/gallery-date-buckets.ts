/**
 * Date labels for the gallery's time headers and quick-jump rail, in the
 * viewer's **local** time (via `Date` getters, not UTC) so headers match what
 * the user expects. The sections themselves come from the server's layout.
 * Pure + dependency-free so it unit-tests without a DOM.
 */

export type Granularity = 'day' | 'month';

function startOfLocalDay(ms: number): number {
	const d = new Date(ms);
	d.setHours(0, 0, 0, 0);
	return d.getTime();
}

/**
 * Whole-day difference between two instants by local midnight. Uses rounding so
 * DST days (23h/25h) still resolve to an integer day count.
 */
function localDayDiff(ms: number, now: number): number {
	return Math.round((startOfLocalDay(now) - startOfLocalDay(ms)) / 86_400_000);
}

/**
 * Human label for a bucket. Month → "June 2026". Day → "Today" / "Yesterday"
 * for the two most recent local days, else a full date. `now` is injectable for
 * deterministic tests.
 */
export function bucketLabel(ms: number, gran: Granularity, now: number = Date.now()): string {
	const d = new Date(ms);
	if (gran === 'month') {
		return d.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
	}
	const diff = localDayDiff(ms, now);
	if (diff === 0) return 'Today';
	if (diff === 1) return 'Yesterday';
	return d.toLocaleDateString(undefined, {
		weekday: 'long',
		month: 'long',
		day: 'numeric',
		year: 'numeric',
	});
}

function parseMonthKey(key: string): { year: number; month: number } {
	const [y, m] = key.split('-');
	// month is 1-12 here; callers convert to a 0-based index where needed.
	return { year: Number(y), month: Number(m) };
}

/** Local start-of-month instant for a `YYYY-MM` key (rail bubble labels). */
export function monthStartMs(key: string): number {
	const { year, month } = parseMonthKey(key);
	return new Date(year, month - 1, 1).getTime();
}
