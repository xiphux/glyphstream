import { describe, expect, it } from 'vitest';
import { formatBytes, formatShortDate } from '#lib/format.js';

describe('formatShortDate', () => {
	const now = new Date(2026, 9, 14);
	it('leaves the year off a date in the current year', () => {
		expect(formatShortDate(new Date(2026, 2, 4).getTime(), now)).not.toMatch(/2026/);
	});
	it('includes the year for a date in another year', () => {
		expect(formatShortDate(new Date(2025, 2, 4).getTime(), now)).toMatch(/2025/);
	});
});

describe('formatBytes', () => {
	it.each([
		[0, '0 B'],
		[1023, '1023 B'],
		[1024, '1.0 KB'],
		[4300, '4.2 KB'],
		[38_000, '37 KB'],
		[1024 * 1024 - 1, '1024 KB'],
		[1.6 * 1024 * 1024, '1.6 MB'],
	])('%d bytes is %s', (bytes, out) => {
		expect(formatBytes(bytes)).toBe(out);
	});
});
