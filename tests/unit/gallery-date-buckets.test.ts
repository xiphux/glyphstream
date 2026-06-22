import { describe, expect, it } from 'vitest';
import {
	bucketKey,
	bucketLabel,
	groupIntoSections,
	monthStartMs,
	nextMonthStartMs,
} from '$lib/gallery-date-buckets';

// Use local-time constructors throughout so assertions hold regardless of the
// machine's timezone (bucketing is intentionally local-time).
const at = (y: number, m1: number, d: number, h = 12) => new Date(y, m1 - 1, d, h).getTime();

describe('bucketKey', () => {
	it('month granularity → YYYY-MM (local)', () => {
		expect(bucketKey(at(2026, 6, 16), 'month')).toBe('2026-06');
		expect(bucketKey(at(2026, 12, 1), 'month')).toBe('2026-12');
	});

	it('day granularity → YYYY-MM-DD (local), zero-padded', () => {
		expect(bucketKey(at(2026, 6, 9), 'day')).toBe('2026-06-09');
		expect(bucketKey(at(2026, 1, 31), 'day')).toBe('2026-01-31');
	});
});

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

describe('groupIntoSections', () => {
	const now = at(2026, 6, 16, 10);
	// Newest-first units, each just an instant.
	const units = [
		at(2026, 6, 16, 9), // Today
		at(2026, 6, 16, 8), // Today
		at(2026, 6, 15, 20), // Yesterday
		at(2026, 5, 30, 12), // May
	];

	it('splits at month boundaries, preserving order', () => {
		const sections = groupIntoSections(units, 'month', (u) => u, now);
		expect(sections.map((s) => s.key)).toEqual(['2026-06', '2026-05']);
		expect(sections[0].units).toHaveLength(3);
		expect(sections[1].units).toHaveLength(1);
	});

	it('splits at day boundaries with relative labels', () => {
		const sections = groupIntoSections(units, 'day', (u) => u, now);
		expect(sections.map((s) => s.label)).toEqual([
			'Today',
			'Yesterday',
			bucketLabel(at(2026, 5, 30), 'day', now),
		]);
		expect(sections[0].units).toHaveLength(2);
	});

	it('empty input → no sections', () => {
		expect(groupIntoSections([], 'month', (u: number) => u, now)).toEqual([]);
	});
});

describe('month bounds', () => {
	it('monthStartMs → local first-of-month midnight', () => {
		expect(monthStartMs('2026-06')).toBe(new Date(2026, 5, 1).getTime());
	});

	it('nextMonthStartMs → start of the following month', () => {
		expect(nextMonthStartMs('2026-06')).toBe(new Date(2026, 6, 1).getTime());
	});

	it('nextMonthStartMs rolls December → next January', () => {
		expect(nextMonthStartMs('2026-12')).toBe(new Date(2027, 0, 1).getTime());
	});
});
