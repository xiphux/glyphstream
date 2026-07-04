/**
 * Pure scheduling-window check for the dreaming worker — the first quiet-hours
 * mechanism in the app. `activeHours` is "HH:MM-HH:MM" (24-hour), interpreted in
 * `timezone` (an IANA name); an empty string means "always open". Handles the
 * overnight wrap (start > end, e.g. "22:00-06:00"). `now` is injected, so the
 * check is deterministic and unit-testable.
 *
 * Config validation (`loadMemoryModelConfig`) guarantees the shape/range and a
 * resolvable timezone by the time this runs, so this stays parsing-light.
 */
export function isWithinWindow(now: Date, activeHours: string, timezone: string): boolean {
	if (!activeHours) return true; // no window configured → always open
	const [start, end] = activeHours.split('-');
	const s = toMinutes(start);
	const e = toMinutes(end);
	const c = toMinutes(localHHMM(now, timezone));
	if (s === e) return true; // degenerate full-day window
	if (s < e) return c >= s && c < e; // same-day window
	return c >= s || c < e; // overnight wrap (e.g. 22:00–06:00)
}

/** Current wall-clock "HH:MM" at `now` in the target IANA zone. */
function localHHMM(now: Date, timezone: string): string {
	const parts = new Intl.DateTimeFormat('en-US', {
		timeZone: timezone,
		hour: '2-digit',
		minute: '2-digit',
		hour12: false,
	}).formatToParts(now);
	const h = parts.find((p) => p.type === 'hour')?.value ?? '00';
	const m = parts.find((p) => p.type === 'minute')?.value ?? '00';
	// Some environments render midnight as "24"; normalize to "00".
	return `${h === '24' ? '00' : h}:${m}`;
}

function toMinutes(hhmm: string): number {
	const [h, m] = hhmm.split(':').map(Number);
	return h * 60 + m;
}
