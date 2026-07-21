/**
 * Pure windowing math for the gallery grid — decides, per date-section, which
 * grid rows to actually render and how much padding to reserve for the rest.
 *
 * The gallery can accumulate thousands of tiles in one infinite-scroll session;
 * rendering every `<li>` bloats the DOM and its layout/style-recalc cost. This
 * module lets the page render only the rows near the viewport and reserve the
 * omitted rows as plain `padding-top`/`padding-bottom` on each section's grid
 * `<ul>`, so total scroll height (and thus every scroll-position / sticky-header
 * / rail measurement the page already does) is preserved exactly.
 *
 * Why this is pure arithmetic and not measure-each-row bookkeeping: the gallery
 * commits to a **constant tile height** (captions are absolute overlays, media
 * is `aspect-square`, so a tile's box is fixed at layout time and never shifts
 * when the image loads). Every grid row is therefore a fixed `rowPitch`, and
 * "which rows are on screen" is a formula. That constant-height contract is the
 * whole reason no virtualization dependency is needed — see the caption overlays
 * in `gallery/+page.svelte`.
 *
 * Exactness: the padding uses only `rowPitch` and the column count, and it is
 * exact for both tile positioning and total height (derivation in the tests).
 * `tileH`/`headerH` feed only the *visibility decision* (which rows intersect
 * the viewport), where a small error just renders a row or two extra and is
 * absorbed by the overscan band — it can never cause scroll drift.
 *
 * Pure + DOM-free so it unit-tests without a browser, like
 * `gallery-date-buckets.ts`.
 */

export interface WindowConstants {
	/** Grid column count at the current breakpoint (>= 1). */
	cols: number;
	/** Vertical distance from one row's top to the next: tile height + row gap (px, > 0). */
	rowPitch: number;
	/** Height of a single tile (px, > 0). `rowPitch - tileH` is the row gap. */
	tileH: number;
	/**
	 * Vertical space a section header consumes in normal flow, from the header's
	 * top to its grid's top (header box + its bottom margin, px, >= 0). Only used
	 * to place section offsets for the visibility decision, so an approximate
	 * value is fine.
	 */
	headerH: number;
}

export interface WindowViewport {
	/** Scroll offset of the scroll container (px). */
	scrollTop: number;
	/** Visible height of the scroll container (px). */
	viewportH: number;
	/** Extra band above and below the viewport to pre-render (px, >= 0). */
	overscanPx: number;
}

export interface SectionWindow {
	/** Total grid rows this section would have if fully rendered. */
	totalRows: number;
	/** First rendered row index within the section. */
	firstRow: number;
	/** Number of rendered rows (0 when the section is fully outside the window). */
	rowCount: number;
	/** First rendered unit index within the section's unit list (inclusive). */
	firstUnit: number;
	/** One past the last rendered unit index (exclusive). */
	unitEnd: number;
	/** Padding to reserve above the rendered rows (px). */
	padTop: number;
	/** Padding to reserve below the rendered rows (px). */
	padBottom: number;
}

function clamp(n: number, lo: number, hi: number): number {
	return n < lo ? lo : n > hi ? hi : n;
}

/** Rows needed to hold `units` items across `cols` columns. */
export function rowsForUnits(units: number, cols: number): number {
	if (units <= 0) return 0;
	return Math.ceil(units / Math.max(1, cols));
}

/** Rendered height of a fully-laid-out grid of `rows` rows. */
export function gridHeight(
	rows: number,
	constants: Pick<WindowConstants, 'rowPitch' | 'tileH'>,
): number {
	if (rows <= 0) return 0;
	// (rows-1) pitches (each a tile + gap) plus one final tile with no trailing gap.
	return (rows - 1) * constants.rowPitch + constants.tileH;
}

/**
 * Compute the render window for a sequence of sections (in DOM order,
 * newest-first). `sectionUnitCounts[i]` is how many render units (tiles and/or
 * stack cards — all one constant height) section `i` holds.
 *
 * Sections are laid out as: [header(headerH)][grid(gridHeight)] repeated with no
 * extra inter-section gap (the header's bottom margin is folded into headerH).
 * Every header stays mounted by the page regardless of this result — only the
 * grid rows are windowed — so section offsets accumulate over the full,
 * unwindowed layout.
 */
export function computeSectionWindows(
	sectionUnitCounts: readonly number[],
	constants: WindowConstants,
	viewport: WindowViewport,
): SectionWindow[] {
	const { cols, rowPitch, headerH } = constants;
	const winTop = viewport.scrollTop - viewport.overscanPx;
	const winBottom = viewport.scrollTop + viewport.viewportH + viewport.overscanPx;

	const out: SectionWindow[] = [];
	let offset = 0; // running top of the current section's header

	for (const units of sectionUnitCounts) {
		const totalRows = rowsForUnits(units, cols);
		const h = gridHeight(totalRows, constants);
		const gridTop = offset + headerH;

		if (totalRows === 0) {
			out.push({
				totalRows,
				firstRow: 0,
				rowCount: 0,
				firstUnit: 0,
				unitEnd: 0,
				padTop: 0,
				padBottom: 0,
			});
			offset = gridTop; // header only, empty grid
			continue;
		}

		// Rows whose vertical span intersects [winTop, winBottom]. `floor` for the
		// first and `ceil` for the last never under-select a visible row (they may
		// include one just outside — absorbed by overscan); see the tests.
		const relTop = winTop - gridTop;
		const relBottom = winBottom - gridTop;
		const firstRow = clamp(Math.floor(relTop / rowPitch), 0, totalRows);
		const lastRow = clamp(Math.ceil(relBottom / rowPitch), 0, totalRows);
		const rowCount = Math.max(0, lastRow - firstRow);

		if (rowCount === 0) {
			// Fully outside the window: reserve the whole grid as padding. The split
			// is irrelevant (nothing renders); keep it all on top for simplicity.
			out.push({
				totalRows,
				firstRow,
				rowCount: 0,
				firstUnit: 0,
				unitEnd: 0,
				padTop: h,
				padBottom: 0,
			});
		} else {
			const firstUnit = firstRow * cols;
			const unitEnd = Math.min(units, lastRow * cols);
			// padTop places the first rendered tile exactly at row `firstRow`; padBottom
			// reserves the rows below. Exact because grid row-gap applies only between
			// tracks, never between padding and the first/last track.
			const padTop = firstRow * rowPitch;
			const padBottom = (totalRows - lastRow) * rowPitch;
			out.push({ totalRows, firstRow, rowCount, firstUnit, unitEnd, padTop, padBottom });
		}

		offset = gridTop + h;
	}

	return out;
}
