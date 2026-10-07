/**
 * Where to scroll `pane` so `row` is in view, or `null` when it already is.
 *
 * Centres a row that is off-screen (a cold sidebar has nothing above the row
 * worth keeping) and leaves a visible one alone, so revealing the row the user
 * just tapped never moves the list under their finger. Geometry comes from
 * bounding rects rather than `offsetTop`, which is relative to the nearest
 * positioned ancestor, not the scroller.
 */
export function revealScrollTop(pane: HTMLElement, row: HTMLElement): number | null {
	const viewHeight = pane.clientHeight;
	// Not laid out: the desktop-collapsed list is `display: none`.
	if (viewHeight === 0) return null;
	const paneRect = pane.getBoundingClientRect();
	const rowRect = row.getBoundingClientRect();
	const top = rowRect.top - paneRect.top + pane.scrollTop;
	const bottom = top + rowRect.height;
	if (top >= pane.scrollTop && bottom <= pane.scrollTop + viewHeight) return null;
	return Math.max(0, top - (viewHeight - rowRect.height) / 2);
}
