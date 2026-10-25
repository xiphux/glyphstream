/**
 * Scheduled-task timing: validating a cadence and finding its next slot.
 *
 * Pure, and in Temporal rather than hand-rolled offset arithmetic, because the
 * hard cases are all time-zone ones — a 02:30 run on the night 02:30 doesn't
 * exist, a 01:30 run on the night it happens twice — and `toZonedDateTime`'s
 * default `compatible` disambiguation answers both the way a person expects
 * (later for a gap, earlier for an overlap). Node 26 ships Temporal.
 */
import type { ScheduleCadence } from '#lib/types/api.js';

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** Longest interval cadence. Past a week, a weekly `daily` says it better. */
export const MAX_INTERVAL_HOURS = 24 * 7;

/** Whether `tz` is an IANA zone this runtime knows. */
export function isValidTimeZone(tz: unknown): tz is string {
	if (typeof tz !== 'string' || tz.length === 0) return false;
	try {
		new Intl.DateTimeFormat('en-US', { timeZone: tz });
		return true;
	} catch {
		return false;
	}
}

/**
 * Parse an untrusted cadence (a request body, a stored row) into a valid one,
 * or a message saying what's wrong with it. `minIntervalHours` is the
 * operator's floor (config), applied to interval cadences only: a daily one
 * fires at most once a day.
 */
export function parseCadence(
	input: unknown,
	minIntervalHours = 1,
): { ok: true; cadence: ScheduleCadence } | { ok: false; error: string } {
	if (!input || typeof input !== 'object') return { ok: false, error: 'cadence is required' };
	const c = input as Record<string, unknown>;
	if (c.kind === 'daily') {
		if (typeof c.time !== 'string' || !HHMM.test(c.time)) {
			return { ok: false, error: 'cadence.time must be "HH:MM" (24-hour)' };
		}
		if (
			!Array.isArray(c.days) ||
			c.days.length === 0 ||
			!c.days.every((d) => Number.isInteger(d) && d >= 0 && d <= 6)
		) {
			return {
				ok: false,
				error: 'cadence.days must list at least one weekday, 0 (Sun) to 6 (Sat)',
			};
		}
		const days = [...new Set(c.days as number[])].sort((a, b) => a - b);
		return { ok: true, cadence: { kind: 'daily', time: c.time, days } };
	}
	if (c.kind === 'interval') {
		const hours = c.everyHours;
		if (typeof hours !== 'number' || !Number.isInteger(hours) || hours < 1) {
			return { ok: false, error: 'cadence.everyHours must be a whole number of hours' };
		}
		if (hours < minIntervalHours) {
			return {
				ok: false,
				error: `This server runs scheduled tasks at most every ${minIntervalHours} hours`,
			};
		}
		if (hours > MAX_INTERVAL_HOURS) {
			return { ok: false, error: `cadence.everyHours can be at most ${MAX_INTERVAL_HOURS}` };
		}
		if (typeof c.anchorAt !== 'number' || !Number.isFinite(c.anchorAt)) {
			return { ok: false, error: 'cadence.anchorAt must be a timestamp' };
		}
		return { ok: true, cadence: { kind: 'interval', everyHours: hours, anchorAt: c.anchorAt } };
	}
	return { ok: false, error: 'cadence.kind must be "daily" or "interval"' };
}

/**
 * The first slot strictly after `after` (unix ms), or null if the cadence has
 * none — which a parsed cadence always does, so null means a corrupt row.
 * Strictly after, so passing the slot that just fired yields the one after it.
 */
export function nextSlotAfter(
	cadence: ScheduleCadence,
	timeZone: string,
	after: number,
): number | null {
	if (cadence.kind === 'interval') {
		const step = cadence.everyHours * 3_600_000;
		if (!(step > 0)) return null;
		// The grid point after `after`; anchors in the future are their own first slot.
		if (after < cadence.anchorAt) return cadence.anchorAt;
		return cadence.anchorAt + (Math.floor((after - cadence.anchorAt) / step) + 1) * step;
	}

	const match = HHMM.exec(cadence.time);
	if (!match || cadence.days.length === 0) return null;
	const time = new Temporal.PlainTime(Number(match[1]), Number(match[2]));
	const days = new Set(cadence.days);
	const start = Temporal.Instant.fromEpochMilliseconds(after)
		.toZonedDateTimeISO(timeZone)
		.toPlainDate();
	// Today's slot may already have passed, so the next one is at most seven
	// days past it — eight dates covers every weekday set.
	for (let i = 0; i <= 7; i++) {
		const date = start.add({ days: i });
		// Temporal numbers Monday 1 … Sunday 7; the cadence uses Sunday 0.
		if (!days.has(date.dayOfWeek % 7)) continue;
		const slot = date.toZonedDateTime({ timeZone, plainTime: time }).epochMilliseconds;
		if (slot > after) return slot;
	}
	return null;
}

/** Longest a schedule's runs are spread from their slot. */
export const MAX_JITTER_MS = 3 * 60_000;

/**
 * How long after its slot this schedule actually fires: a fixed offset per
 * schedule, derived from its id. Everyone in a household picks 07:00, and a
 * shared GPU would otherwise get every morning brief in the same second.
 * Deterministic so a given schedule fires at the same moment every time.
 */
export function jitterFor(scheduleId: string): number {
	// FNV-1a: cheap, stable, and spreads short ids well enough for minutes.
	let h = 0x811c9dc5;
	for (let i = 0; i < scheduleId.length; i++) {
		h ^= scheduleId.charCodeAt(i);
		h = Math.imul(h, 0x01000193);
	}
	return (h >>> 0) % MAX_JITTER_MS;
}
