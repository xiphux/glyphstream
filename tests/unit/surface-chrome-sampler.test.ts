/* @vitest-environment happy-dom */
/**
 * The iOS standalone status bar takes its color from .status-bar-sampler's
 * background, and the stylesheet sets that to `var(--color-surface)` — an oklch
 * value. This repo has already established, on a real WebKit, that iOS drops a
 * `theme-color` it cannot parse (see toLegacyRgb); the sampler is the same
 * color arriving through a different channel, so it gets the same treatment.
 *
 * That makes the inline write load-bearing rather than cosmetic, and it lives
 * in a function named for the meta tag — so it is exactly the kind of thing a
 * later edit tidies away. Hence a test naming the element.
 *
 * Nothing here asserts the CONVERSION: happy-dom's canvas can't paint, so
 * toLegacyRgb's readback sentinel correctly refuses to trust it and passes the
 * value through. The conversion is covered on real engines by the e2e theme
 * switcher assertion in flows.spec.ts. What this pins is the plumbing — that
 * the sampler is found and written at all, from the same call the meta is.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { syncSurfaceChrome } from '$lib/theme-color';

/** Already legacy rgb(), so toLegacyRgb short-circuits and the canvas — which
 *  happy-dom cannot honour — never enters into it. */
const SURFACE = 'rgb(8, 11, 16)';

beforeEach(() => {
	document.head.innerHTML = '';
	document.body.innerHTML = '';
	document.body.style.backgroundColor = SURFACE;
});

describe('syncSurfaceChrome — status bar sampler', () => {
	it('writes the resolved surface onto the sampler', () => {
		const sampler = document.createElement('div');
		sampler.className = 'status-bar-sampler';
		document.body.appendChild(sampler);

		syncSurfaceChrome();

		expect(sampler.style.backgroundColor).toBe(SURFACE);
	});

	it('still updates the meta, which is the other half of the same call', () => {
		syncSurfaceChrome();
		expect(document.querySelector('meta[name="theme-color"]')?.getAttribute('content')).toBe(
			SURFACE,
		);
	});

	it('tolerates the sampler being absent', () => {
		// It ships in the root layout, but this runs from five call sites and an
		// error thrown here would take the theme switch down with it.
		expect(() => syncSurfaceChrome()).not.toThrow();
		expect(document.querySelector('.status-bar-sampler')).toBeNull();
	});

	it('overwrites a stale color on a theme flip', () => {
		// The point of re-running it on every theme/scheme change: the inline
		// style outranks the stylesheet, so a value left behind would pin the
		// status bar to the previous theme's surface forever.
		const sampler = document.createElement('div');
		sampler.className = 'status-bar-sampler';
		sampler.style.backgroundColor = 'rgb(247, 250, 254)';
		document.body.appendChild(sampler);

		syncSurfaceChrome();

		expect(sampler.style.backgroundColor).toBe(SURFACE);
	});
});
