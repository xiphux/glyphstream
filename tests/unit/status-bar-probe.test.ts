/* @vitest-environment happy-dom */
/**
 * The status-bar probe's gates, which are WebKit's gates.
 *
 * This is the only place they get exercised. `display-mode: standalone` can't
 * be emulated by Playwright, so captureColdLaunchProbe() never fires in any
 * automated browser we run, and the thing it reports on — whether iOS has a
 * colour to paint the status bar with — is invisible from inside the page on
 * every platform that isn't an installed iOS web app.
 *
 * Geometry is stubbed per element: happy-dom lays nothing out, so every
 * getBoundingClientRect is zeros unless it's told otherwise. That's fine for
 * what's under test — the gates are arithmetic over a rect and a computed
 * style, not layout itself.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

/**
 * happy-dom can represent neither half of the oklch case on its own: it DROPS
 * an `oklch()` declaration (computed background comes back ''), and it has no
 * 2D canvas context, so the real toLegacyRgb — which converts by painting a
 * pixel — is a pass-through here. Both are stubbed rather than worked around:
 * `paint()` below supplies the computed value, and this supplies the
 * conversion. What is under test is the probe's own handling of the two
 * notations, not the converter, which is theme-color's concern and is
 * exercised against real engines elsewhere.
 */
const OKLCH_SURFACE = 'oklch(0.15 0.012 258)';
const RGB_SURFACE = 'rgb(8, 11, 16)';
vi.mock('$lib/theme-color', () => ({
	toLegacyRgb: (value: string) => (value === OKLCH_SURFACE ? RGB_SURFACE : value),
}));

import { probeStatusBarContainer } from '../../src/lib/status-bar-probe';

/** Wide enough to clear minimumRatio against happy-dom's 1024px window. */
const FULL = 1024;

function place(
	el: HTMLElement,
	rect: { width: number; height: number; top?: number; left?: number },
): void {
	const top = rect.top ?? 0;
	const left = rect.left ?? 0;
	el.getBoundingClientRect = () =>
		({
			width: rect.width,
			height: rect.height,
			top,
			left,
			right: left + rect.width,
			bottom: top + rect.height,
			x: left,
			y: top,
		}) as DOMRect;
}

/** A container at the top of the page, with whatever style the case needs. */
function mount(
	css: string,
	rect: { width: number; height: number; top?: number; left?: number },
): HTMLElement {
	const el = document.createElement('div');
	el.style.cssText = css;
	place(el, rect);
	document.body.appendChild(el);
	return el;
}

/**
 * Computed backgrounds the stylesheet can't express here. happy-dom silently
 * discards an `oklch()` declaration, so setting one inline would test the
 * absence of a background rather than an oklch one. This overrides what
 * getComputedStyle reports for a specific element, leaving every other element
 * on the real implementation.
 */
const painted = new WeakMap<Element, string>();
function paint(el: Element, backgroundColor: string): void {
	painted.set(el, backgroundColor);
}

beforeAll(() => {
	const real = window.getComputedStyle.bind(window);
	vi.spyOn(window, 'getComputedStyle').mockImplementation(((
		el: Element,
		pseudo?: string | null,
	) => {
		const style = real(el as Element, pseudo ?? undefined);
		const override = painted.get(el);
		if (override === undefined) return style;
		return new Proxy(style, {
			// `unknown`: Reflect.get is typed `any`, and no-unsafe-return is on
			// for tests/ as well as src/.
			get: (target, prop, receiver): unknown =>
				prop === 'backgroundColor' ? override : Reflect.get(target, prop, receiver),
		});
	}) as typeof window.getComputedStyle);
});

afterEach(() => {
	document.body.innerHTML = '';
	document.body.style.cssText = '';
});

describe('probeStatusBarContainer', () => {
	it('reports nothing to sample when no element at the top is fixed or sticky', () => {
		mount('position:static;background-color:rgb(8, 11, 16);', { width: FULL, height: 48 });
		expect(probeStatusBarContainer()).toEqual({
			container: null,
			color: null,
			reason: 'no fixed or sticky container',
		});
	});

	/**
	 * The regression this whole mechanism was built around: the 1px sampler
	 * strip that shipped for months. Note WHICH gate turns it away — it isn't
	 * the size one. The probe point is 4px down (sampleRectMargin), so a strip
	 * spanning y 0..1 doesn't contain it and is never a candidate at all. That
	 * is why making the element merely "opaque enough" never helped: WebKit's
	 * hit test was landing past it, on content that wasn't fixed or sticky.
	 */
	it('never even sees a hairline strip, because the probe point is below it', () => {
		mount('position:fixed;background-color:rgb(8, 11, 16);', { width: FULL, height: 1 });
		expect(probeStatusBarContainer()).toEqual({
			container: null,
			color: null,
			reason: 'no fixed or sticky container',
		});
	});

	/** Tall enough to reach the probe point, still inside thinBorderWidth. */
	it('rejects a strip that reaches the probe point but stays within thinBorderWidth', () => {
		mount('position:fixed;background-color:rgb(8, 11, 16);', { width: FULL, height: 10 });
		const result = probeStatusBarContainer();
		expect(result.color).toBeNull();
		expect(result.reason).toMatch(/too thin/);
	});

	it('rejects a container narrower than minimumRatio', () => {
		// Centred, so it still spans the probe point at innerWidth / 2 — the
		// width gate is what has to reject it, not the geometry.
		mount('position:fixed;background-color:rgb(8, 11, 16);', {
			width: 700,
			height: 48,
			left: 162,
		});
		const result = probeStatusBarContainer();
		expect(result.color).toBeNull();
		expect(result.reason).toMatch(/too narrow/);
	});

	it('samples a sticky top bar that carries the surface colour', () => {
		document.body.style.backgroundColor = 'rgb(8, 11, 16)';
		const bar = mount('position:sticky;background-color:rgb(8, 11, 16);', {
			width: FULL,
			height: 48,
		});
		bar.className = 'sticky top-0';
		place(document.body, { width: FULL, height: 800 });
		const result = probeStatusBarContainer();
		expect(result.reason).toBeNull();
		expect(result.color).toBe('rgb(8, 11, 16)');
		expect(result.container).toBe('div.sticky.top-0');
	});

	/**
	 * hasMultipleBackgroundColors: WebKit keeps collecting backgrounds up the
	 * chain and DISCARDS the colour if two disagree. This is why the top bar has
	 * to be given body's colour rather than any colour — the failure mode is not
	 * "wrong tint", it's the blur coming back.
	 */
	it('discards the colour when an ancestor disagrees', () => {
		document.body.style.backgroundColor = 'rgb(255, 255, 255)';
		place(document.body, { width: FULL, height: 800 });
		const bar = mount('position:sticky;background-color:rgb(8, 11, 16);', {
			width: FULL,
			height: 48,
		});
		bar.className = 'top-bar';
		const result = probeStatusBarContainer();
		expect(result.color).toBeNull();
		expect(result.reason).toMatch(/conflicting backgrounds/);
	});

	it('discards the colour when the chain carries a backdrop-filter', () => {
		const bar = mount(
			'position:fixed;background-color:rgb(8, 11, 16);backdrop-filter:blur(12px);',
			{ width: FULL, height: 48 },
		);
		bar.className = 'surface-glass';
		const result = probeStatusBarContainer();
		expect(result.color).toBeNull();
		expect(result.reason).toMatch(/backdrop-filter/);
	});

	/**
	 * The colours this app actually paints. Every surface token is authored in
	 * oklch and `getComputedStyle` hands it back verbatim — measured on both
	 * engines, see toLegacyRgb — so a probe that only understood `rgb()` read
	 * every real background as "nothing painted here" and reported NOT sampled
	 * on precisely the routes the sampling fix was written for. The rest of this
	 * file uses rgb() literals and is structurally blind to that, which is how
	 * it shipped; these two cases are the guard.
	 */
	it('samples a container whose background is oklch, like every real surface', () => {
		place(document.body, { width: FULL, height: 800 });
		paint(document.body, OKLCH_SURFACE);
		const bar = mount('position:sticky;', { width: FULL, height: 48 });
		bar.className = 'sticky top-0';
		paint(bar, OKLCH_SURFACE);
		const result = probeStatusBarContainer();
		expect(result.reason).toBeNull();
		expect(result.color).toBe(RGB_SURFACE);
	});

	/**
	 * The other half, and the reason widening the parser alone would have made
	 * things worse: on (auth) the sampler carries an INLINE rgb() written by
	 * syncSurfaceChrome while body keeps the stylesheet's oklch. Same colour,
	 * two notations. Compared raw, that reads as a conflict and discards a
	 * perfectly good sample.
	 */
	it('does not call one colour a conflict with itself across notations', () => {
		place(document.body, { width: FULL, height: 800 });
		paint(document.body, OKLCH_SURFACE);
		// The sampler's inline rgb(), as syncSurfaceChrome writes it, over a
		// body still carrying the stylesheet's oklch. The same colour.
		const bar = mount('position:fixed;', { width: FULL, height: 48 });
		bar.className = 'status-bar-sampler';
		paint(bar, RGB_SURFACE);
		const result = probeStatusBarContainer();
		expect(result.reason).toBeNull();
		expect(result.color).toBe(RGB_SURFACE);
	});

	it('ignores a fixed element that does not span the probe point', () => {
		// A bottom-anchored toast: fixed and full width, but nowhere near y=4.
		mount('position:fixed;background-color:rgb(8, 11, 16);', {
			width: FULL,
			height: 48,
			top: 700,
		});
		expect(probeStatusBarContainer().reason).toBe('no fixed or sticky container');
	});
});
