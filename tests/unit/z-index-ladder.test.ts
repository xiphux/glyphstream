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
 * So: no arbitrary `z-[N]` in components. A new surface has to pick a tier
 * from the ladder, or add one — which is a diff someone reviews, rather than a
 * number nobody compares against the other eleven.
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

	it('assigns every tier a distinct value', () => {
		// Two tiers sharing a number is the original bug with nicer names: the
		// order then silently falls to paint order again.
		const values = [...declaredTiers().values()];
		expect(values.length).toBe(new Set(values).size);
	});

	it('uses no arbitrary z-[N] in components', () => {
		const offenders = files
			.filter((f) => /class="[^"]*\bz-\[\d+\]/.test(f.text))
			.map((f) => f.path);
		expect(
			offenders,
			'pick a tier from the ladder in app.css (z-overlay, z-toast, …) or add one there',
		).toEqual([]);
	});

	it('uses no bare z-30 or above in components', () => {
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
