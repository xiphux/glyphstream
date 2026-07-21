import { describe, expect, it } from 'vitest';
import { buildLayoutSections, dayStartMs, monthTicksFromLayout } from '$lib/gallery-layout';

// Fixed "now" well after the fixtures so no day resolves to Today/Yesterday.
const NOW = new Date(2024, 11, 31, 12).getTime();

const days = [
	{ key: '2024-06-15', units: 3 },
	{ key: '2024-06-14', units: 2 },
	{ key: '2024-05-30', units: 4 },
	{ key: '2024-05-01', units: 1 },
];

describe('buildLayoutSections — day granularity', () => {
	it('one section per day with running start indices', () => {
		const s = buildLayoutSections(days, 'day', NOW);
		expect(
			s.map((x) => ({ key: x.key, unitCount: x.unitCount, startIndex: x.startIndex })),
		).toEqual([
			{ key: '2024-06-15', unitCount: 3, startIndex: 0 },
			{ key: '2024-06-14', unitCount: 2, startIndex: 3 },
			{ key: '2024-05-30', unitCount: 4, startIndex: 5 },
			{ key: '2024-05-01', unitCount: 1, startIndex: 9 },
		]);
	});
});

describe('buildLayoutSections — month granularity', () => {
	it('aggregates contiguous days into one section per month, indices intact', () => {
		const s = buildLayoutSections(days, 'month', NOW);
		expect(
			s.map((x) => ({ key: x.key, unitCount: x.unitCount, startIndex: x.startIndex })),
		).toEqual([
			{ key: '2024-06', unitCount: 5, startIndex: 0 }, // 3 + 2
			{ key: '2024-05', unitCount: 5, startIndex: 5 }, // 4 + 1
		]);
	});

	it('total units across sections is preserved at both granularities', () => {
		const total = days.reduce((n, d) => n + d.units, 0);
		for (const g of ['day', 'month'] as const) {
			expect(buildLayoutSections(days, g, NOW).reduce((n, s) => n + s.unitCount, 0)).toBe(total);
		}
	});

	it('empty layout → no sections', () => {
		expect(buildLayoutSections([], 'month', NOW)).toEqual([]);
	});
});

describe('dayStartMs', () => {
	it('is local midnight of the day key', () => {
		expect(dayStartMs('2024-06-15')).toBe(new Date(2024, 5, 15).getTime());
	});
});

describe('monthTicksFromLayout', () => {
	it('one tick per month with unit counts, newest-first', () => {
		expect(monthTicksFromLayout(days)).toEqual([
			{ key: '2024-06', count: 5 },
			{ key: '2024-05', count: 5 },
		]);
	});
});
