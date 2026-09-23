/**
 * Ask, on the device, the question the iOS status bar's appearance turns on:
 * would WebKit find an element to sample at the top of this page, and what
 * colour would it read from it?
 *
 * This exists because the answer is decided ONCE, early, and is invisible from
 * inside the page. WebKit samples in `LocalFrameView::fixedContainerEdges()`;
 * if it finds a usable colour the standalone status bar is painted with it, and
 * if it doesn't, iOS 26/27 lays its Liquid Glass blur over the top of the app
 * instead. Nothing in the DOM, no event and no media query reports which
 * happened — the only signal is looking at the phone.
 *
 * And the debug panel can't answer it for itself, because reaching the panel
 * means opening the sidebar drawer, whose `fixed inset-0` scrim then covers the
 * probe point and becomes the answer. Whatever the panel measured at the moment
 * it opened would describe the drawer, not the launch. So the reading is taken
 * at mount and kept; see captureColdLaunchProbe.
 *
 * The gates below are WebKit's, transcribed from
 * Source/WebCore/page/LocalFrameView.cpp. Two places where this deliberately
 * diverges, both toward being readable rather than exact:
 *
 *   - WebKit hit-tests one point and walks ANCESTORS of whatever it hits. This
 *     scans for fixed/sticky elements whose box contains that point instead,
 *     because `elementFromPoint` skips `pointer-events: none` while WebKit's
 *     sampling hit test sets IgnoreCSSPointerEventsProperty on its first pass —
 *     and the (auth) sampler is pointer-events:none, i.e. exactly the case the
 *     DOM API would lie about.
 *   - WebKit starts collecting background colours at the hit node, which may be
 *     a descendant of the container. This starts at the container. A child with
 *     its own conflicting background would be missed here and caught there.
 *
 * So treat a clean result as "the shape is right", not as proof. A FAILING
 * result is the trustworthy direction: if this can't find a container, WebKit
 * certainly couldn't either.
 */

/** Where WebKit probes: the top edge midpoint after `contract({ sampleRectMargin })`. */
const SAMPLE_RECT_MARGIN = 4;
/** `thinBorderWidth` — a box this size or smaller in EITHER dimension is rejected. */
const THIN_BORDER_WIDTH = 10;
/** `minimumRatio` — the container must span this much of the viewport's width. */
const MINIMUM_RATIO = 0.9;
/** Cost ceiling for the one-shot scan; a page past this is not worth the reflow. */
const MAX_ELEMENTS = 4000;

export interface StatusBarProbe {
	/** The element WebKit would sample, as a short selector-ish label. */
	container: string | null;
	/** The colour it would read from that element's chain. */
	color: string | null;
	/** Why there is no usable colour. Null when there is one. */
	reason: string | null;
}

/** `div.sticky.top-0` — enough to recognise the element, short enough for a row. */
function describe(el: Element): string {
	const classes =
		typeof el.className === 'string' && el.className.trim()
			? `.${el.className.trim().split(/\s+/).slice(0, 3).join('.')}`
			: '';
	return `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''}${classes}`;
}

/** Alpha 0 means "nothing painted here", not "painted transparent". */
function isVisibleColor(value: string): boolean {
	const inner = /^rgba?\(([^)]*)\)$/i.exec(value.trim())?.[1];
	if (inner === undefined) return false;
	const alpha = inner.includes('/') ? inner.split('/')[1] : inner.split(',')[3];
	return alpha === undefined || Number(alpha.trim()) !== 0;
}

/**
 * Run the sample now, against the live DOM.
 *
 * Exported for the unit tests, which is the only way this gets exercised off a
 * real device: `display-mode: standalone` can't be emulated by Playwright, so
 * the capture below never fires in any automated browser we run.
 */
export function probeStatusBarContainer(): StatusBarProbe {
	const x = Math.floor(window.innerWidth / 2);
	const y = SAMPLE_RECT_MARGIN;

	const all = document.body.querySelectorAll('*');
	if (all.length > MAX_ELEMENTS) {
		return { container: null, color: null, reason: `not scanned (${all.length} elements)` };
	}

	// Last match wins: later in document order is later in paint order among
	// equally-stacked elements, which is the closest cheap stand-in for "the one
	// the hit test would have landed on".
	let container: HTMLElement | null = null;
	for (const el of all) {
		if (!(el instanceof HTMLElement)) continue;
		const style = getComputedStyle(el);
		if (style.position !== 'fixed' && style.position !== 'sticky') continue;
		const rect = el.getBoundingClientRect();
		if (rect.left > x || rect.right < x || rect.top > y || rect.bottom < y) continue;
		if (style.visibility === 'hidden' || style.display === 'none') continue;
		// Only a value that actually parses to 0 counts as hidden. `Number('')`
		// is 0, so testing the number alone would discard every element on any
		// engine that reports an empty opacity — failing toward "nothing to
		// sample", which is the one answer this must never invent.
		if (style.opacity !== '' && Number(style.opacity) === 0) continue;
		const z = Number(style.zIndex);
		if (Number.isFinite(z) && z < 0) continue;
		container = el;
	}

	if (!container) return { container: null, color: null, reason: 'no fixed or sticky container' };

	const label = describe(container);
	const rect = container.getBoundingClientRect();
	if (rect.width <= THIN_BORDER_WIDTH || rect.height <= THIN_BORDER_WIDTH) {
		return {
			container: label,
			color: null,
			reason: `too thin (${Math.round(rect.width)}x${Math.round(rect.height)}, needs >${THIN_BORDER_WIDTH})`,
		};
	}
	if (rect.width < window.innerWidth * MINIMUM_RATIO) {
		return {
			container: label,
			color: null,
			reason: `too narrow (${Math.round(rect.width)} of ${window.innerWidth})`,
		};
	}

	// The colour comes from the first visible background walking up, and is
	// DISCARDED if two ancestors disagree (hasMultipleBackgroundColors) or if
	// anything in the chain carries a backdrop-filter.
	let color: string | null = null;
	for (let el: HTMLElement | null = container; el; el = el.parentElement) {
		const style = getComputedStyle(el);
		// The prefixed form through getPropertyValue: it isn't on the typed
		// CSSStyleDeclaration, and it is the one WebKit actually reports.
		const filter = style.backdropFilter || style.getPropertyValue('-webkit-backdrop-filter');
		if (filter && filter !== 'none') {
			return { container: label, color: null, reason: `backdrop-filter on ${describe(el)}` };
		}
		const bg = style.backgroundColor;
		if (!isVisibleColor(bg)) continue;
		if (color === null) color = bg;
		else if (color !== bg) {
			return {
				container: label,
				color: null,
				reason: `conflicting backgrounds (${color} vs ${bg} on ${describe(el)})`,
			};
		}
	}

	return color === null
		? { container: label, color: null, reason: 'no background colour in the chain' }
		: { container: label, color, reason: null };
}

/**
 * The reading taken at mount, before anything the user does can change it.
 *
 * Module state, written only from the root layout's mount effect. Effects don't
 * run during SSR, so the server copy of this module stays null and one request
 * can't publish into another's render — the same rule the `.svelte.ts`
 * singletons follow, and the reason this write must not migrate to init depth.
 */
let coldLaunch: StatusBarProbe | null = null;

/**
 * Standalone-only, and once per process. Off a home screen this measures
 * nothing anyone can act on, and the scan is not worth paying for on every
 * page load in a browser tab where iOS paints no status bar at all.
 */
export function captureColdLaunchProbe(): void {
	if (coldLaunch !== null) return;
	try {
		if (!window.matchMedia('(display-mode: standalone)').matches) return;
		coldLaunch = probeStatusBarContainer();
	} catch {
		// A diagnostic that throws is worse than one that prints a dash.
	}
}

export function readColdLaunchProbe(): StatusBarProbe | null {
	return coldLaunch;
}
