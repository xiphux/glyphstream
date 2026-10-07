/**
 * Where to scroll `pane` so `row` is in view, or `null` when it already is.
 *
 * Centres a row that is entirely off-screen (a cold sidebar has nothing above
 * the row worth keeping) and leaves a fully visible one alone. A row clipped at
 * an edge — the one most often tapped at the bottom of a long list — is nudged
 * just far enough to show it, not re-centred, so revealing the row the user
 * just tapped never jumps the list out from under their finger. Geometry comes from
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
	const viewTop = pane.scrollTop;
	const viewBottom = viewTop + viewHeight;
	if (top >= viewTop && bottom <= viewBottom) return null;
	if (bottom <= viewTop || top >= viewBottom) {
		return Math.max(0, top - (viewHeight - rowRect.height) / 2);
	}
	return top < viewTop ? top : bottom - viewHeight;
}
