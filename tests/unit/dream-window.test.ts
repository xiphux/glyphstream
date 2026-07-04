import { describe, expect, it } from 'vitest';
import { isWithinWindow } from '$lib/server/memory/dream-window';

// A fixed UTC instant: 03:00 UTC on a winter date (so America/New_York = UTC-5).
const AT_0300_UTC = new Date('2026-01-15T03:00:00Z');

describe('isWithinWindow', () => {
	it('is always open when no window is configured', () => {
		expect(isWithinWindow(AT_0300_UTC, '', 'UTC')).toBe(true);
	});

	it('same-day window: inside vs outside', () => {
		expect(isWithinWindow(AT_0300_UTC, '02:00-06:00', 'UTC')).toBe(true);
		expect(isWithinWindow(new Date('2026-01-15T07:00:00Z'), '02:00-06:00', 'UTC')).toBe(false);
		// End is exclusive.
		expect(isWithinWindow(new Date('2026-01-15T06:00:00Z'), '02:00-06:00', 'UTC')).toBe(false);
		// Start is inclusive.
		expect(isWithinWindow(new Date('2026-01-15T02:00:00Z'), '02:00-06:00', 'UTC')).toBe(true);
	});

	it('overnight wrap (start > end)', () => {
		const w = '22:00-06:00';
		expect(isWithinWindow(new Date('2026-01-15T23:00:00Z'), w, 'UTC')).toBe(true);
		expect(isWithinWindow(new Date('2026-01-15T05:00:00Z'), w, 'UTC')).toBe(true);
		expect(isWithinWindow(new Date('2026-01-15T12:00:00Z'), w, 'UTC')).toBe(false);
	});

	it('interprets the window in the configured timezone', () => {
		// 03:00 UTC is 22:00 the previous day in New York (UTC-5 in January).
		expect(isWithinWindow(AT_0300_UTC, '02:00-06:00', 'UTC')).toBe(true);
		expect(isWithinWindow(AT_0300_UTC, '02:00-06:00', 'America/New_York')).toBe(false);
		// The overnight window that spans 22:00 catches it in NY.
		expect(isWithinWindow(AT_0300_UTC, '21:00-06:00', 'America/New_York')).toBe(true);
	});
});
