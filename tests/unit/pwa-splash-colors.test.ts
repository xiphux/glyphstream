/**
 * Holds the iOS launch images to the colour the app actually paints.
 *
 * The whole point of the splash is a seamless handoff, so the one thing it
 * must get right is the background — and that is exactly what went wrong: the
 * dark images shipped as `#0f172a` (the brand navy from icon.svg's tile and the
 * manifest) while `body` in dark mode paints `--color-surface`, `#080b10`. That
 * is ΔE2000 ~9.5, roughly 4.5x the deliberate surface-to-sidebar step and a
 * lightness jump, so the launch visibly flashed — the defect the feature exists
 * to remove, in its own base case.
 *
 * Nothing caught it. `pwa-splash-manifest.test.ts` asserts hrefs, geometry and
 * file presence and never looks at a pixel; the value was plausible, matched
 * two real colours elsewhere in the tree, and had a confident comment claiming
 * it tracked app.css.
 *
 * So this derives the expectation from `app.css` rather than restating the
 * constant: it parses the Signature theme's `--color-surface` oklch out of the
 * stylesheet, converts to sRGB, and compares against the actual corner pixel of
 * a generated PNG. That catches both a wrong constant in the generator AND a
 * future retune of the design token that nobody thought to regenerate for.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';

const appCss = readFileSync(fileURLToPath(new URL('../../src/app.css', import.meta.url)), 'utf-8');
const splashDir = fileURLToPath(new URL('../../static/splash/', import.meta.url));

/**
 * OKLCH -> sRGB (Björn Ottosson's OKLab matrices + the sRGB transfer function).
 * Inlined rather than pulled from a colour library: it's ~20 lines, the repo
 * ships no colour dependency, and a test that needs a new runtime dep to guard
 * two constants isn't worth its weight.
 */
function oklchToRgb(l: number, c: number, hDeg: number): [number, number, number] {
	const h = (hDeg * Math.PI) / 180;
	const a = c * Math.cos(h);
	const b = c * Math.sin(h);

	const l_ = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3;
	const m_ = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3;
	const s_ = (l - 0.0894841775 * a - 1.291485548 * b) ** 3;

	const lin = [
		4.0767416621 * l_ - 3.3077115913 * m_ + 0.2309699292 * s_,
		-1.2684380046 * l_ + 2.6097574011 * m_ - 0.3413193965 * s_,
		-0.0041960863 * l_ - 0.7034186147 * m_ + 1.707614701 * s_,
	];
	return lin.map((v) => {
		const srgb = v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
		return Math.round(Math.min(1, Math.max(0, srgb)) * 255);
	}) as [number, number, number];
}

/**
 * The Signature (default) theme's `--color-surface` for a scheme. Light lives
 * in the base `@theme` block; dark in `[data-scheme='dark']`. Both are matched
 * as the FIRST declaration at or after their block opener, so the Claude /
 * ChatGPT `[data-theme=…]` blocks further down can't be picked up by accident.
 */
function surfaceOklch(scheme: 'light' | 'dark'): [number, number, number] {
	const from =
		scheme === 'dark' ? appCss.indexOf("[data-scheme='dark'] {") : appCss.indexOf('@theme');
	expect(from, `could not locate the ${scheme} block in app.css`).toBeGreaterThan(-1);
	const m = /--color-surface:\s*oklch\(\s*([\d.]+)(%?)\s+([\d.]+)\s+([\d.]+)\s*\)/.exec(
		appCss.slice(from),
	);
	expect(m, `no --color-surface in the ${scheme} block`).not.toBeNull();
	const lRaw = Number(m![1]);
	// app.css writes lightness both ways — `98.5%` light, `15%` dark, and bare
	// fractions in the alternate themes. Normalise to 0..1.
	return [m![2] === '%' ? lRaw / 100 : lRaw, Number(m![3]), Number(m![4])];
}

/**
 * Top-left pixel of a PNG. These are palette images, so the bytes can't be read
 * off the header — it needs a real decode, and `sharp` is already a runtime
 * dependency. Extracting 1x1 first keeps it from materialising ~11 MB of raw
 * pixels to look at three bytes.
 */
async function cornerPixel(file: string): Promise<[number, number, number]> {
	const buf = await sharp(`${splashDir}${file}`)
		.extract({ left: 0, top: 0, width: 1, height: 1 })
		.raw()
		.toBuffer();
	return [buf[0], buf[1], buf[2]];
}

describe('iOS launch-image colours', () => {
	it.each([
		['dark', '1170x2532-dark.png'],
		['light', '1170x2532-light.png'],
	] as const)('%s splash matches the app surface it hands off to', async (scheme, file) => {
		const [l, c, h] = surfaceOklch(scheme);
		const expected = oklchToRgb(l, c, h);
		const actual = await cornerPixel(file);
		// Exact: both sides are deterministic, and the generator fills a flat
		// field with the very value this computes. A tolerance here would let
		// the original 7/12/26-per-channel miss slip straight through.
		//
		// The message carries the hex to paste, the way csp-inline-script-hash
		// does — otherwise fixing a failure means hand-running a colour
		// converter to find out what the constant should have been.
		const hex = `#${expected.map((v) => v.toString(16).padStart(2, '0')).join('')}`;
		expect(
			actual,
			`${file} is the wrong colour. Set SCHEMES.${scheme}.bg to '${hex}' in ` +
				`scripts/generate-pwa-splash.ts and re-run \`pnpm gen:splash\``,
		).toEqual(expected);
	});
});
