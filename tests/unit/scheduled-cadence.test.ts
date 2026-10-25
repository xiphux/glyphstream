import { describe, expect, it } from 'vitest';
import {
	jitterFor,
	MAX_JITTER_MS,
	nextSlotAfter,
	parseCadence,
} from '#lib/server/scheduled/cadence.js';
import type { ScheduleCadence } from '#lib/types/api.js';

const NY = 'America/New_York';
const at = (iso: string) => Temporal.Instant.from(iso).epochMilliseconds;
const iso = (ms: number | null, tz = NY) =>
	ms === null ? null : Temporal.Instant.fromEpochMilliseconds(ms).toZonedDateTimeISO(tz).toString();
const daily = (time: string, days = [0, 1, 2, 3, 4, 5, 6]): ScheduleCadence => ({
	kind: 'daily',
	time,
	days,
});

describe('nextSlotAfter — daily', () => {
	it("is today's time when it hasn't passed yet", () => {
		expect(iso(nextSlotAfter(daily('07:00'), NY, at('2026-10-20T06:00:00-04:00')))).toBe(
			'2026-10-20T07:00:00-04:00[America/New_York]',
		);
	});

	it("is tomorrow's when today's has passed — and when it's exactly now", () => {
		const slot = at('2026-10-20T07:00:00-04:00');
		expect(iso(nextSlotAfter(daily('07:00'), NY, slot))).toBe(
			'2026-10-21T07:00:00-04:00[America/New_York]',
		);
	});

	it('skips to the next listed weekday', () => {
		// 2026-10-23 is a Friday; weekdays only → Monday the 26th.
		expect(
			iso(nextSlotAfter(daily('07:00', [1, 2, 3, 4, 5]), NY, at('2026-10-23T08:00:00-04:00'))),
		).toBe('2026-10-26T07:00:00-04:00[America/New_York]');
	});

	it('finds a weekly slot a full week out', () => {
		// Tuesday only, asked just after Tuesday's slot.
		expect(iso(nextSlotAfter(daily('07:00', [2]), NY, at('2026-10-20T07:00:01-04:00')))).toBe(
			'2026-10-27T07:00:00-04:00[America/New_York]',
		);
	});

	it('reads the time in the schedule’s zone, not the server’s', () => {
		const slot = nextSlotAfter(daily('07:00'), 'Asia/Tokyo', at('2026-10-20T00:00:00Z'));
		expect(iso(slot, 'Asia/Tokyo')).toBe('2026-10-21T07:00:00+09:00[Asia/Tokyo]');
	});

	it('runs a time inside the spring-forward gap as late as the gap is long', () => {
		// 2026-03-08: New York jumps 02:00 → 03:00, so 02:30 doesn't exist.
		expect(iso(nextSlotAfter(daily('02:30'), NY, at('2026-03-08T00:00:00-05:00')))).toBe(
			'2026-03-08T03:30:00-04:00[America/New_York]',
		);
	});

	it('runs a repeated fall-back time once, the first time', () => {
		// 2026-11-01: 01:00–02:00 happens twice in New York.
		const first = nextSlotAfter(daily('01:30'), NY, at('2026-11-01T00:00:00-04:00'));
		expect(iso(first)).toBe('2026-11-01T01:30:00-04:00[America/New_York]');
		// The repeat an hour later is not a slot; the next one is tomorrow's.
		expect(iso(nextSlotAfter(daily('01:30'), NY, first!))).toBe(
			'2026-11-02T01:30:00-05:00[America/New_York]',
		);
	});

	it('keeps local time across a DST change rather than drifting an hour', () => {
		const before = nextSlotAfter(daily('07:00'), NY, at('2026-10-31T08:00:00-04:00'));
		expect(iso(before)).toBe('2026-11-01T07:00:00-05:00[America/New_York]');
	});
});

describe('nextSlotAfter — interval', () => {
	const anchorAt = at('2026-10-20T09:00:00Z');
	const every4: ScheduleCadence = { kind: 'interval', everyHours: 4, anchorAt };

	it('steps along the anchored grid', () => {
		expect(nextSlotAfter(every4, NY, anchorAt)).toBe(anchorAt + 4 * 3_600_000);
		expect(nextSlotAfter(every4, NY, anchorAt + 5 * 3_600_000)).toBe(anchorAt + 8 * 3_600_000);
	});

	it('treats a future anchor as the first slot', () => {
		expect(nextSlotAfter(every4, NY, anchorAt - 1)).toBe(anchorAt);
	});

	it('jumps past a long outage to the next grid point, not the missed ones', () => {
		const weekLater = anchorAt + 7 * 24 * 3_600_000 + 1;
		expect(nextSlotAfter(every4, NY, weekLater)).toBe(anchorAt + (7 * 6 + 1) * 4 * 3_600_000);
	});
});

describe('parseCadence', () => {
	it('accepts and normalizes a daily cadence', () => {
		expect(parseCadence({ kind: 'daily', time: '07:05', days: [5, 1, 1] })).toEqual({
			ok: true,
			cadence: { kind: 'daily', time: '07:05', days: [1, 5] },
		});
	});

	it.each([
		[{ kind: 'daily', time: '7:00', days: [1] }, /HH:MM/],
		[{ kind: 'daily', time: '24:00', days: [1] }, /HH:MM/],
		[{ kind: 'daily', time: '07:00', days: [] }, /weekday/],
		[{ kind: 'daily', time: '07:00', days: [7] }, /weekday/],
		[{ kind: 'interval', everyHours: 1.5, anchorAt: 0 }, /whole number/],
		[{ kind: 'interval', everyHours: 2 }, /anchorAt/],
		[{ kind: 'cron', expr: '* * * * *' }, /kind/],
		[null, /required/],
	])('rejects %j', (input, message) => {
		const r = parseCadence(input);
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.error).toMatch(message);
	});

	it("holds an interval to the operator's floor", () => {
		const r = parseCadence({ kind: 'interval', everyHours: 2, anchorAt: 0 }, 6);
		expect(r).toEqual({
			ok: false,
			error: 'This server runs scheduled tasks at most every 6 hours',
		});
	});
});

describe('jitterFor', () => {
	it('is stable per schedule and inside the window', () => {
		const ids = Array.from({ length: 50 }, (_, i) => `schedule-${i}`);
		for (const id of ids) {
			expect(jitterFor(id)).toBe(jitterFor(id));
			expect(jitterFor(id)).toBeGreaterThanOrEqual(0);
			expect(jitterFor(id)).toBeLessThan(MAX_JITTER_MS);
		}
		// Spread out, not all the same offset.
		expect(new Set(ids.map(jitterFor)).size).toBeGreaterThan(40);
	});
});
