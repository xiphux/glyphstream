/**
 * Tailwind's generated CSS, checked in the stylesheets the browser actually
 * loaded from the production build.
 *
 * Tailwind's failure mode is emitting NOTHING: a class it doesn't recognise, a
 * variant it no longer wraps the same way, or a source file its scanner stopped
 * reading all type-check, lint, and render — just unstyled (CLAUDE.md lists three
 * of these we've shipped). 4.x minors auto-merge, and nothing else in CI looks at
 * CSS output, so:
 *
 *   - Every class on every element of every app page must be matched by some
 *     loaded rule. This catches scanner/candidate regressions wholesale, and
 *     catches our own typos too — its first run found `text-on-accent`, a token
 *     that never existed, on two settings pages.
 *   - The two custom variants in app.css still compile to what the design
 *     relies on: `dark:` keyed to `[data-scheme=dark]`, `can-hover:` inside
 *     `@media (hover: hover)`.
 *   - The `dark:` scheme swap actually changes computed colors end to end.
 *
 * Classes that are hooks, not styles, are allowlisted by pattern below.
 */
import { test, expect, type Page } from './fixtures/test';
import { resetData, seedConversation } from './helpers';

test.skip(({ isMobile }) => isMobile, 'CSS output is viewport-independent; desktop covers it');

/** Class names that are markers for JS or other libraries, with no CSS of ours. */
const HOOK_CLASSES = [/^svelte-/, /^lucide(-|$)/];

interface LoadedCss {
	/** Every class name appearing in any loaded selector. */
	classes: string[];
	/** selectorText of rules nested (at any depth) inside a (hover: hover) media rule. */
	hoverMediaSelectors: string[];
	/** Every top-level-or-nested selectorText, for spot checks. */
	selectors: string[];
}

function loadedCss(page: Page): Promise<LoadedCss> {
	return page.evaluate(() => {
		const classes = new Set<string>();
		const hoverMediaSelectors: string[] = [];
		const selectors: string[] = [];
		const walk = (rules: CSSRuleList, inHover: boolean) => {
			for (const rule of rules) {
				if (rule instanceof CSSStyleRule) {
					selectors.push(rule.selectorText);
					if (inHover) hoverMediaSelectors.push(rule.selectorText);
					for (const m of rule.selectorText.matchAll(/\.((?:\\.|[\w-])+)/g)) {
						classes.add(m[1].replace(/\\(.)/g, '$1'));
					}
				}
				if ('cssRules' in rule && rule.cssRules) {
					const hover =
						inHover ||
						(rule instanceof CSSMediaRule &&
							/\(\s*hover\s*:\s*hover\s*\)/.test(rule.conditionText));
					walk(rule.cssRules as CSSRuleList, hover);
				}
			}
		};
		for (const sheet of document.styleSheets) walk(sheet.cssRules, false);
		return { classes: [...classes], hoverMediaSelectors, selectors };
	});
}

function pageClasses(page: Page): Promise<string[]> {
	return page.evaluate(() => {
		const s = new Set<string>();
		for (const el of document.querySelectorAll('[class]')) for (const c of el.classList) s.add(c);
		return [...s];
	});
}

test.beforeEach(() => {
	resetData();
});

test('every class rendered on an app page has generated CSS', async ({ page }) => {
	const chatId = seedConversation('tailwind output');
	const paths = [
		'/',
		`/chat/${chatId}`,
		'/gallery',
		'/archived',
		'/settings/preferences',
		'/settings/models',
		'/settings/memories',
		'/settings/security',
		'/settings/users',
		'/settings/endpoints',
		'/settings/mcp',
		'/settings/skills',
		'/settings/snippets',
		'/settings/permissions',
	];

	const missing: string[] = [];
	for (const path of paths) {
		await page.goto(path);
		await page.waitForLoadState('networkidle');
		const css = new Set((await loadedCss(page)).classes);
		for (const c of await pageClasses(page)) {
			if (css.has(c) || HOOK_CLASSES.some((re) => re.test(c))) continue;
			missing.push(`${path}: .${c}`);
		}
	}
	expect(
		missing,
		'classes in the DOM with no CSS rule (typo, or Tailwind stopped emitting)',
	).toEqual([]);
});

test('custom variants compile to the selectors app.css intends', async ({ page }) => {
	await page.goto('/');
	await page.waitForLoadState('networkidle');
	const css = await loadedCss(page);

	// `dark:` is attribute-driven, not prefers-color-scheme.
	const dark = css.selectors.filter((s) => s.includes('dark\\:'));
	expect(dark.length).toBeGreaterThan(0);
	for (const s of dark) expect(s).toMatch(/\[data-scheme=["']?dark["']?\]/);

	// `can-hover:` hides only where a hover can bring the control back.
	const canHover = css.selectors.filter((s) => s.includes('can-hover\\:'));
	expect(canHover.length).toBeGreaterThan(0);
	for (const s of canHover) expect(css.hoverMediaSelectors).toContain(s);
});

test('the data-scheme swap changes computed theme colors', async ({ page }) => {
	await page.goto('/');
	const colors = async (scheme: 'light' | 'dark') => {
		await page.evaluate((s) => document.documentElement.setAttribute('data-scheme', s), scheme);
		return page.evaluate(() => {
			const probe = document.createElement('div');
			probe.className = 'bg-surface text-fg dark:ring-white/15 ring-1';
			document.body.append(probe);
			const cs = getComputedStyle(probe);
			const out = { bg: cs.backgroundColor, fg: cs.color, ring: cs.boxShadow };
			probe.remove();
			return out;
		});
	};
	const light = await colors('light');
	const dark = await colors('dark');
	// Tokens resolved to real colors, not the transparent/inherited fallback.
	expect(light.bg).not.toMatch(/rgba\(0, 0, 0, 0\)|transparent/);
	expect(dark.bg).not.toBe(light.bg);
	expect(dark.fg).not.toBe(light.fg);
	expect(dark.ring).not.toBe(light.ring);
});
