/**
 * Client-side date bucketing for the gallery's time headers + quick-jump rail.
 *
 * The gallery feed is already reverse-chronological, so grouping is a single
 * pass that opens a new section whenever the local-time bucket key changes — no
 * re-sort. All bucketing is done in the viewer's **local** time (via `Date`
 * getters, not UTC) so headers match what the user expects. Pure + dependency-
 * free so it unit-tests without a DOM.
 */

export type Granularity = 'day' | 'month';

function pad2(n: number): string {
	return n < 10 ? `0${n}` : String(n);
}

/** Local-time bucket key: `YYYY-MM` (month) or `YYYY-MM-DD` (day). */
export function bucketKey(ms: number, gran: Granularity): string {
	const d = new Date(ms);
	const ym = `${d.getFullYear()}-${pad2(d.getMonth() + 1)}`;
	return gran === 'month' ? ym : `${ym}-${pad2(d.getDate())}`;
}

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

export interface DateSection<T> {
	key: string;
	label: string;
	units: T[];
}

/**
 * Group an already-newest-first list into contiguous date sections. `getDate`
 * maps a unit (a gallery stack or a flat item) to its representative instant
 * (epoch ms) — for a stack, its newest member's `createdAt`.
 */
export function groupIntoSections<T>(
	units: readonly T[],
	gran: Granularity,
	getDate: (u: T) => number,
	now: number = Date.now(),
): DateSection<T>[] {
	const sections: DateSection<T>[] = [];
	let current: DateSection<T> | null = null;
	for (const u of units) {
		const ms = getDate(u);
		const key = bucketKey(ms, gran);
		if (!current || current.key !== key) {
			current = { key, label: bucketLabel(ms, gran, now), units: [] };
			sections.push(current);
		}
		current.units.push(u);
	}
	return sections;
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

/**
 * Local start of the month *after* a `YYYY-MM` key — the exclusive `before`
 * anchor for a month seek (createdAt < this = that month and older). Computed
 * locally so a jump lands consistent with the local-time headers. Handles the
 * December → January rollover via JS Date normalization.
 */
export function nextMonthStartMs(key: string): number {
	const { year, month } = parseMonthKey(key);
	return new Date(year, month, 1).getTime();
}
