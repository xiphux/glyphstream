import { describe, expect, it } from 'vitest';
import { bucketLabel, monthStartMs } from '#lib/gallery-date-buckets.js';

// Use local-time constructors throughout so assertions hold regardless of the
// machine's timezone (bucketing is intentionally local-time).
const at = (y: number, m1: number, d: number, h = 12) => new Date(y, m1 - 1, d, h).getTime();

describe('bucketLabel', () => {
	const now = at(2026, 6, 16, 10);

	it('month → "Month YYYY"', () => {
		expect(bucketLabel(at(2026, 6, 16), 'month')).toBe('June 2026');
	});

	it('day → relative Today / Yesterday near now', () => {
		expect(bucketLabel(at(2026, 6, 16, 8), 'day', now)).toBe('Today');
		expect(bucketLabel(at(2026, 6, 15, 23), 'day', now)).toBe('Yesterday');
	});

	it('day → full date when older than yesterday', () => {
		const label = bucketLabel(at(2026, 6, 1), 'day', now);
		expect(label).not.toBe('Today');
		expect(label).not.toBe('Yesterday');
		expect(label).toContain('2026');
	});
});

describe('month bounds', () => {
	it('monthStartMs → local first-of-month midnight', () => {
		expect(monthStartMs('2026-06')).toBe(new Date(2026, 5, 1).getTime());
	});
});
