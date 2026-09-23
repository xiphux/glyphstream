/**
 * Keeps viewport-level surfaces on the named stacking ladder in app.css.
 *
 * The ordering used to live as bare numbers spread across a dozen components,
 * and it broke exactly the way that arrangement breaks: the toast and a dialog
 * backdrop both picked 50, the tie fell to paint order, and the toast rendered
 * behind `bg-black/60 backdrop-blur` — present in the DOM, reported visible by
 * Playwright, invisible to a human. Nothing could have caught that, because
 * there was nowhere for "toast outranks modals" to be written down as code.
 *
 * So: no arbitrary bracketed z-index values in components. A new surface has
 * to pick a tier from the ladder, or add one — which is a diff someone
 * reviews, rather than a number nobody compares against the other eleven.
 *
 * (Deliberately not spelling that pattern out literally anywhere in this file.
 * Tailwind's scanner is a raw-text extractor: it reads comments and string
 * literals alike, with no notion of which is which, so a literal example
 * anywhere in the repo gets compiled into a real rule in the shipped
 * stylesheet — and for an arbitrary-value shape, an invalid one. The tier names
 * that DO appear below, in an assertion message, are harmless for a different
 * reason: they're valid utilities already emitted for real usage, so they cost
 * nothing extra. Being quoted is not what saves them.)
 *
 * Bare Tailwind steps (`z-0`, `z-10`, `z-20`) are still allowed: those are
 * local stacking inside a component's own `relative` parent (the home page's
 * aura behind its content, the gallery rail over its list) and have nothing to
 * do with the global ladder. Anything at 30 or above is a viewport-level
 * surface and must be named.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const srcDir = fileURLToPath(new URL('../../src/', import.meta.url));
const cssPath = fileURLToPath(new URL('../../src/app.css', import.meta.url));

function svelteFiles(dir: string): string[] {
	return readdirSync(dir).flatMap((entry) => {
		const full = `${dir}${entry}`;
		if (statSync(full).isDirectory()) return svelteFiles(`${full}/`);
		return entry.endsWith('.svelte') ? [full] : [];
	});
}

const files = svelteFiles(srcDir).map((path) => ({
	path: path.slice(srcDir.length),
	text: readFileSync(path, 'utf-8'),
}));

/** Tier names declared in app.css's `@theme` block. */
function declaredTiers(): Map<string, number> {
	const css = readFileSync(cssPath, 'utf-8');
	const tiers = new Map<string, number>();
	for (const m of css.matchAll(/--z-index-([a-z-]+):\s*(\d+)\s*;/g)) {
		tiers.set(m[1], Number(m[2]));
	}
	return tiers;
}

describe('global stacking ladder', () => {
	it('declares the tiers in app.css', () => {
		const tiers = declaredTiers();
		// If this ever empties out, every assertion below passes vacuously.
		expect(tiers.size).toBeGreaterThan(0);
		expect([...tiers.keys()]).toEqual(
			expect.arrayContaining(['overlay', 'toast', 'update', 'sidebar']),
		);
	});

	it('orders toast and the update prompt above the overlay tier', () => {
		// The specific invariant the original bug violated, stated as code.
		const t = declaredTiers();
		expect(t.get('toast')!).toBeGreaterThan(t.get('overlay')!);
		expect(t.get('update')!).toBeGreaterThan(t.get('toast')!);
		expect(t.get('overlay')!).toBeGreaterThan(t.get('sidebar')!);
	});

	it('keeps the status-bar sampler in its band: over the scrim, under overlays', () => {
		// HISTORICAL, and the assertions are kept for inertia rather than for
		// the reasons below — read app.css's sampler rule before acting on this.
		// The sampler now exists only on the (auth) routes, where neither
		// pressure applies: those three pages have no drawer and no lightbox.
		// It is also 12px, not the 1px the ceiling argument was about.
		//
		// What the two bounds were for, when the sampler was on every route:
		//
		// Floor: the drawer backdrop is `fixed inset-0`, always mounted and
		// merely faded out when shut, so a sampler below it lost this edge
		// permanently — iOS read a transparent element and fell back to the
		// translucent bar.
		//
		// Ceiling: at the top of the ladder the sampler painted a 1px
		// surface-coloured hairline over every full-viewport dark overlay, since
		// under the `default` status-bar style this strip is on-screen content.
		// Under the overlay tier, an open lightbox or dialog is what iOS samples,
		// which is also the colour the bar should take.
		//
		// Both bounds are still asserted because each was violated in turn, and a
		// bare "outranks the backdrop" passes the version that caused the
		// hairline — so if the sampler ever returns to a route that has either,
		// the tier it needs is already pinned.
		const t = declaredTiers();
		const statusBar = t.get('status-bar')!;
		expect(statusBar).toBeGreaterThan(t.get('drawer-backdrop')!);
		expect(statusBar).toBeLessThan(t.get('overlay')!);
	});

	it('assigns every tier a distinct value', () => {
		// Two tiers sharing a number is the original bug with nicer names: the
		// order then silently falls to paint order again.
		const values = [...declaredTiers().values()];
		expect(values.length).toBe(new Set(values).size);
	});

	it('uses no arbitrary bracketed z-index values in components', () => {
		const offenders = files
			.filter((f) => /class="[^"]*\bz-\[\d+\]/.test(f.text))
			.map((f) => f.path);
		expect(
			offenders,
			'pick a tier from the ladder in app.css (z-overlay, z-toast, …) or add one there',
		).toEqual([]);
	});

	it('uses no bare numeric tier at 30 or above in components', () => {
		// 30+ is where viewport-level surfaces start; below that is local.
		const offenders = files
			.filter((f) => /class="[^"]*\bz-(3\d|[4-9]\d|\d{3,})\b/.test(f.text))
			.map((f) => f.path);
		expect(
			offenders,
			'a viewport-level surface must use a named tier from app.css, not a bare number',
		).toEqual([]);
	});
});
