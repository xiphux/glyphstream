/**
 * Turn the server's per-day unit counts (the gallery "layout") into the ordered
 * sections the virtualized grid reserves height for — before any unit data has
 * loaded. Pure + DOM-free so it unit-tests without a browser, like its sibling
 * `gallery-date-buckets.ts` (whose label/bucket helpers it reuses).
 *
 * The server sends day-granularity counts (the finest bucket); this aggregates
 * them to whole months for the default month view, or passes them through for
 * the day view. Either way each section carries the global unit index it starts
 * at, so the grid can map a windowed section-local row back to an absolute unit
 * position for demand-loading.
 */

import { bucketLabel, monthStartMs, type Granularity } from './gallery-date-buckets';

/** A layout day count from `/api/media/layout` (`GalleryLayout.days[n]`). */
export interface LayoutDay {
	/** Local-time `YYYY-MM-DD`. */
	key: string;
	/** Top-level units (stacks + solos) whose leader falls in this day. */
	units: number;
}

export interface LayoutSection {
	/** `YYYY-MM` (month view) or `YYYY-MM-DD` (day view). */
	key: string;
	label: string;
	/** Units in this section (drives its reserved grid height). */
	unitCount: number;
	/** Global index of this section's first unit in the newest-first stream. */
	startIndex: number;
}

/** Local midnight instant for a `YYYY-MM-DD` key (for day-header labels). */
export function dayStartMs(dayKey: string): number {
	const [y, m, d] = dayKey.split('-').map(Number);
	return new Date(y, m - 1, d).getTime();
}

/**
 * Build the grid's sections from the layout's newest-first day counts. `now` is
 * injectable so the relative day labels ("Today"/"Yesterday") stay deterministic
 * in tests.
 */
export function buildLayoutSections(
	days: readonly LayoutDay[],
	gran: Granularity,
	now: number = Date.now(),
): LayoutSection[] {
	const sections: LayoutSection[] = [];
	let startIndex = 0;

	if (gran === 'day') {
		for (const d of days) {
			sections.push({
				key: d.key,
				label: bucketLabel(dayStartMs(d.key), 'day', now),
				unitCount: d.units,
				startIndex,
			});
			startIndex += d.units;
		}
		return sections;
	}

	// Month view: aggregate the (already newest-first, contiguous-per-month) days
	// into one section per `YYYY-MM`.
	let current: LayoutSection | null = null;
	for (const d of days) {
		const monthKey = d.key.slice(0, 7);
		if (!current || current.key !== monthKey) {
			current = {
				key: monthKey,
				label: bucketLabel(monthStartMs(monthKey), 'month', now),
				unitCount: 0,
				startIndex,
			};
			sections.push(current);
		}
		current.unitCount += d.units;
		startIndex += d.units;
	}
	return sections;
}

/**
 * Month tick-marks for the timeline rail, derived from the same layout (so the
 * rail can never disagree with the reserved section heights). `count` is unit
 * count, matching what the sections reserve.
 */
export function monthTicksFromLayout(days: readonly LayoutDay[]): { key: string; count: number }[] {
	return buildLayoutSections(days, 'month', 0).map((s) => ({ key: s.key, count: s.unitCount }));
}
