import { describe, expect, it } from 'vitest';
import {
	computeSectionWindows,
	gridHeight,
	rowsForUnits,
	type SectionWindow,
	type WindowConstants,
} from '$lib/gallery-window';

// A clean set of constants: 100px tiles, 12px row gap → 112px pitch, 40px
// headers, 4 columns. Round numbers keep the arithmetic assertions legible.
const C: WindowConstants = { cols: 4, rowPitch: 112, tileH: 100, headerH: 40 };

/**
 * The invariant that makes windowing safe: for every section, the rendered
 * height (padTop + rendered-rows content + padBottom) must equal the height of
 * the fully-laid-out grid, so total scroll height is preserved bit-for-bit.
 * Rendered-rows content for c rows = (c-1)*pitch + tileH (grid gaps sit only
 * between tracks). This checks the exact-height derivation the module claims.
 */
function assertHeightPreserved(w: SectionWindow, c: WindowConstants) {
	const full = gridHeight(w.totalRows, c);
	const rendered = w.rowCount > 0 ? (w.rowCount - 1) * c.rowPitch + c.tileH : 0;
	expect(w.padTop + rendered + w.padBottom).toBe(full);
}

describe('rowsForUnits', () => {
	it('ceils units over columns', () => {
		expect(rowsForUnits(0, 4)).toBe(0);
		expect(rowsForUnits(1, 4)).toBe(1);
		expect(rowsForUnits(4, 4)).toBe(1);
		expect(rowsForUnits(5, 4)).toBe(2);
		expect(rowsForUnits(9, 4)).toBe(3);
	});
});

describe('gridHeight', () => {
	it('is (rows-1)*pitch + tileH, i.e. no trailing gap after the last row', () => {
		expect(gridHeight(0, C)).toBe(0);
		expect(gridHeight(1, C)).toBe(100); // one tile, no gap
		expect(gridHeight(2, C)).toBe(212); // 100 + 12 + 100
		expect(gridHeight(3, C)).toBe(324); // 100 + 12 + 100 + 12 + 100
	});
});

describe('computeSectionWindows — single section', () => {
	it('renders only the rows intersecting the viewport (+overscan)', () => {
		// 40 units / 4 cols = 10 rows. Header at 0, grid from y=40.
		// Viewport [400, 700] → relative to gridTop(40): [360, 660], overscan 0.
		// firstRow = floor(360/112) = 3, lastRow = ceil(660/112) = 6 → rows 3..5.
		const [w] = computeSectionWindows([40], C, { scrollTop: 400, viewportH: 300, overscanPx: 0 });
		expect(w.totalRows).toBe(10);
		expect(w.firstRow).toBe(3);
		expect(w.rowCount).toBe(3);
		expect(w.firstUnit).toBe(12); // 3 * 4
		expect(w.unitEnd).toBe(24); // 6 * 4
		expect(w.padTop).toBe(3 * 112);
		expect(w.padBottom).toBe((10 - 6) * 112);
		assertHeightPreserved(w, C);
	});

	it('clamps the last slice to the real unit count (short final row)', () => {
		// 10 units / 4 cols = 3 rows; the last row holds only 2 units.
		// A window covering the whole section must end unitEnd at 10, not 12.
		const [w] = computeSectionWindows([10], C, { scrollTop: 0, viewportH: 10_000, overscanPx: 0 });
		expect(w.totalRows).toBe(3);
		expect(w.firstRow).toBe(0);
		expect(w.rowCount).toBe(3);
		expect(w.firstUnit).toBe(0);
		expect(w.unitEnd).toBe(10); // min(10, 3*4)
		expect(w.padTop).toBe(0);
		expect(w.padBottom).toBe(0);
		assertHeightPreserved(w, C);
	});

	it('renders nothing but reserves full height when scrolled far past the section', () => {
		// 40 units = 10 rows, grid spans [40, 40+gridHeight(10)] = [40, 1048].
		// Viewport starts at 5000 → fully below. Nothing rendered, full grid as pad.
		const [w] = computeSectionWindows([40], C, { scrollTop: 5000, viewportH: 300, overscanPx: 0 });
		expect(w.rowCount).toBe(0);
		expect(w.firstUnit).toBe(0);
		expect(w.unitEnd).toBe(0);
		expect(w.padTop).toBe(gridHeight(10, C));
		expect(w.padBottom).toBe(0);
		assertHeightPreserved(w, C);
	});

	it('renders nothing when the section is entirely above the viewport', () => {
		// Section 0 is small (4 units = 1 row). Put the viewport well below it.
		const [w] = computeSectionWindows([4], C, { scrollTop: 4000, viewportH: 300, overscanPx: 0 });
		expect(w.rowCount).toBe(0);
		expect(w.padTop).toBe(gridHeight(1, C));
		assertHeightPreserved(w, C);
	});
});

describe('computeSectionWindows — empty section', () => {
	it('emits a zero window and consumes only its header offset', () => {
		// An empty section (0 units) followed by a real one: the second section's
		// visibility must account for the first's header height but no grid.
		const wins = computeSectionWindows([0, 40], C, { scrollTop: 0, viewportH: 200, overscanPx: 0 });
		expect(wins[0]).toMatchObject({ totalRows: 0, rowCount: 0, padTop: 0, padBottom: 0 });
		// Second section's header sits at y=40 (first header only), grid at y=80.
		// Viewport [0,200] → still catches the top rows of section 2.
		expect(wins[1].firstRow).toBe(0);
		expect(wins[1].rowCount).toBeGreaterThan(0);
	});
});

describe('computeSectionWindows — multiple sections', () => {
	it('accumulates offsets so only the on-screen section renders rows', () => {
		// Three sections of 40 units (10 rows, gridHeight(10)=1108) each.
		// Section tops: header0=0 grid0=[40,1148]; header1=1148 grid1=[1188,2296];
		// header2=2296 grid2=[2336,3444].
		// Put the viewport squarely inside section 1: scrollTop 1400, h 300.
		const wins = computeSectionWindows([40, 40, 40], C, {
			scrollTop: 1400,
			viewportH: 300,
			overscanPx: 0,
		});
		expect(wins[0].rowCount).toBe(0); // section 0 fully above
		expect(wins[1].rowCount).toBeGreaterThan(0); // section 1 on screen
		expect(wins[2].rowCount).toBe(0); // section 2 fully below
		wins.forEach((w) => assertHeightPreserved(w, C));

		// gridTop1 = 1188, rel window [1400-1188, 1700-1188] = [212, 512] →
		// firstRow floor(212/112)=1.
		expect(wins[1].firstRow).toBe(1);
	});

	it('can render rows across a section boundary (overscan spanning two grids)', () => {
		const wins = computeSectionWindows([40, 40], C, {
			scrollTop: 1000, // near the bottom of section 0 / top of section 1
			viewportH: 300,
			overscanPx: 200,
		});
		expect(wins[0].rowCount).toBeGreaterThan(0);
		expect(wins[1].rowCount).toBeGreaterThan(0);
		wins.forEach((w) => assertHeightPreserved(w, C));
	});
});

describe('computeSectionWindows — height preservation is total', () => {
	it('sum of all sections rendered+padded height equals the sum of full grids, at any scroll', () => {
		const counts = [37, 5, 60, 1, 24];
		for (const scrollTop of [0, 250, 900, 1500, 3000, 99_999]) {
			const wins = computeSectionWindows(counts, C, { scrollTop, viewportH: 400, overscanPx: 150 });
			wins.forEach((w) => assertHeightPreserved(w, C));
			// And every rendered slice is a whole number of grid columns wide at its
			// start (a row boundary), never mid-row.
			wins.forEach((w) => {
				if (w.rowCount > 0) expect(w.firstUnit % C.cols).toBe(0);
			});
		}
	});
});

describe('computeSectionWindows — never under-selects a visible row', () => {
	it('the row containing any viewport pixel is always within [firstRow,lastRow)', () => {
		// Brute-force a single tall section: for a spread of scroll positions,
		// every row physically overlapping the (overscan-free) viewport must be
		// rendered. Guards the floor/ceil boundary math against off-by-one.
		const units = 200; // 50 rows
		const totalRows = rowsForUnits(units, C.cols);
		const gridTop = C.headerH;
		for (let scrollTop = 0; scrollTop < 5000; scrollTop += 37) {
			const viewportH = 500;
			const [w] = computeSectionWindows([units], C, { scrollTop, viewportH, overscanPx: 0 });
			for (let r = 0; r < totalRows; r++) {
				const rowTop = gridTop + r * C.rowPitch;
				const rowBottom = rowTop + C.tileH;
				const overlaps = rowBottom > scrollTop && rowTop < scrollTop + viewportH;
				if (overlaps) {
					expect(r).toBeGreaterThanOrEqual(w.firstRow);
					expect(r).toBeLessThan(w.firstRow + w.rowCount);
				}
			}
		}
	});
});
