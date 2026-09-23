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
 * Source/WebCore/page/LocalFrameView.cpp. Three places where this deliberately
 * diverges, all toward being readable rather than exact:
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
 *   - A real hit test resolves stacking contexts. This ranks candidates by
 *     computed z-index alone (see the scan), which agrees with paint order
 *     only while they share one — true of every fixed top-edge element here.
 *
 * It also reports the colour it finds rather than the colour iOS would paint:
 * WebKit blends a container below `minimumOpacityThresholdToClampToSolidColor`
 * (0.75) over the page background instead of taking it neat, and clamps the
 * rest to opaque. So a translucent container reads here as the value it
 * declares, not the composite that reaches the bar.
 *
 * So treat a clean result as "the shape is right", not as proof. A FAILING
 * result is the trustworthy direction: if this can't find a container, WebKit
 * certainly couldn't either.
 */

import { toLegacyRgb } from '$lib/theme-color';

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

/**
 * Alpha 0 means "nothing painted here", not "painted transparent".
 *
 * Every notation, not just `rgb()`. This used to match `/^rgba?\(…\)$/` and
 * return false for anything else — which read every `oklch()` background in
 * this app as "no background at all", i.e. every surface it exists to measure.
 * Callers normalise through toLegacyRgb first, but that deliberately passes a
 * translucent colour through unconverted, so a non-rgb string still arrives
 * here and must be understood rather than discarded.
 *
 * An unrecognised serialisation counts as PAINTED. The direction matters: this
 * module's contract is that a failure is the trustworthy answer, so the one
 * thing it must never do is invent "nothing to sample" out of a colour it
 * merely failed to parse.
 */
function isVisibleColor(value: string): boolean {
	const v = value.trim();
	if (!v || v === 'transparent' || v === 'none') return false;
	const inner = /^[a-z]+\(([^)]*)\)$/i.exec(v)?.[1];
	if (inner === undefined) return true;
	// Both serialisations: legacy `r, g, b, a` and modern `r g b / a`.
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

	// Highest stacking order wins, document order breaking ties — an
	// approximation of "the one the hit test would have landed on".
	//
	// This used to take the last match in document order outright, justified as
	// paint order "among equally-stacked elements". The candidates here are not
	// equally stacked: the drawer's scrim is `fixed inset-0` at
	// --z-index-drawer-backdrop (30) while the mobile top bar is `sticky` at
	// `auto`, and the bar is ~460 lines further down the layout, so document
	// order alone picks the bar while the scrim is what actually paints over
	// the probe point. Comparing z first makes the code mean what that comment
	// already claimed.
	//
	// Still an approximation, and knowingly: `auto` is scored 0, which is right
	// only while every candidate shares a stacking context. Nothing in this app
	// nests a fixed top-edge element inside a transformed or filtered ancestor,
	// and the cost of getting it wrong is a mislabelled diagnostic rather than a
	// mislabelled page.
	let container: HTMLElement | null = null;
	let containerZ = 0;
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
		const parsed = Number(style.zIndex);
		// `auto` (and an engine reporting '') parses to NaN; treat it as 0, the
		// level it paints at, rather than letting NaN poison the comparison.
		const z = Number.isFinite(parsed) ? parsed : 0;
		if (z < 0) continue;
		if (container !== null && z < containerZ) continue;
		container = el;
		containerZ = z;
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
		// Normalise BEFORE testing or comparing. The same colour reaches this
		// loop in two notations — `rgb()` on .status-bar-sampler, which
		// syncSurfaceChrome overwrites inline, and `oklch()` from the stylesheet
		// on body and html — so comparing the raw strings reports a conflict
		// between a colour and itself, and the (auth) chain is exactly that
		// shape. Converting both ends first is what makes the equality below
		// mean what it says.
		const bg = toLegacyRgb(style.backgroundColor);
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
