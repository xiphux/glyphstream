/**
 * The status-bar sampler carries an INLINE background written by
 * syncSurfaceChrome(), and an inline declaration outranks the stylesheet for
 * the life of the element. So `background-color: var(--color-surface)` in
 * app.css stops being what the sampler shows the moment that function first
 * runs, and the token no longer propagates on its own.
 *
 * That turns a cascade guarantee into a convention: every site that can change
 * --color-surface has to call the sync by hand. Three do today — the theme
 * effect, the scheme effect, and the `data-private` re-tint — and the third was
 * added only after shipping the inline write without it, which left the
 * installed iOS status bar on the previous surface while the app went violet.
 *
 * Nothing structural prevents a fourth from landing the same way. This is the
 * cheap guard: find every attribute on <html> that app.css keys a
 * --color-surface override off, and require the module owning each one to call
 * syncSurfaceChrome. It is deliberately a coarse, grep-shaped test — it cannot
 * prove the call is reachable, only that the author of a new mutator was made
 * to think about it, which is the failure mode that actually occurred.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const srcDir = fileURLToPath(new URL('../../src/', import.meta.url));
const appCss = readFileSync(`${srcDir}app.css`, 'utf-8');

function svelteFiles(dir: string): string[] {
	return readdirSync(dir).flatMap((entry) => {
		const full = `${dir}${entry}`;
		if (statSync(full).isDirectory()) return svelteFiles(`${full}/`);
		return entry.endsWith('.svelte') || entry.endsWith('.svelte.ts') ? [full] : [];
	});
}

/**
 * `data-*` attributes app.css redefines --color-surface under.
 *
 * Matched off each rule's PRELUDE rather than by scanning for a `[data-…]`
 * followed by a brace. The looser form found the right three by luck: it let a
 * combined selector (`[data-scheme='dark'][data-contrast]`), a selector list,
 * and a preceding comment each swallow the attribute that followed, so a newly
 * added re-tint could land in any of those shapes and never be seen — this
 * file's own drift check, passing vacuously.
 *
 * A comment inside a prelude can now contribute a spurious attribute. That is
 * the safe direction: a spurious one only adds a sync requirement somewhere.
 */
function surfaceAttributes(): string[] {
	const found = new Set<string>();
	for (const rule of appCss.matchAll(/([^{}]*)\{([^{}]*)\}/g)) {
		if (!rule[2].includes('--color-surface:')) continue;
		for (const attr of rule[1].matchAll(/\[data-([a-z0-9-]+)/g)) found.add(attr[1]);
	}
	return [...found].sort();
}

/**
 * The `{ … }` body enclosing `index` — the effect or handler doing the write.
 * Brace-counted rather than regex-matched, because the bodies nest. A brace
 * inside a string, a regex literal or a comment can throw the count off; see
 * the fallback at the bottom for why that direction is safe.
 */
function enclosingBlock(text: string, index: number): string {
	let start = text.lastIndexOf('{', index);
	while (start > 0) {
		let depth = 0;
		for (let i = start; i < text.length; i++) {
			if (text[i] === '{') depth++;
			else if (text[i] === '}' && --depth === 0) {
				if (i > index) return text.slice(start, i + 1);
				break;
			}
		}
		start = text.lastIndexOf('{', start - 1);
	}
	// No enclosing block — a top-level write, or a brace the counter lost track
	// of. Returns EMPTY, which reports an offender, never the whole file, which
	// would not: the file almost certainly holds some other syncSurfaceChrome()
	// call, and matching that is exactly the per-file check this helper exists
	// to be stronger than. Verified against the real tree: every current write
	// resolves to a real block, so nothing reaches here today.
	return '';
}

describe('surface-color re-sync', () => {
	it('finds the attributes app.css re-tints the surface under', () => {
		// Guards the regex: if this ever returns nothing, every assertion below
		// passes vacuously and the drift it exists to catch goes unnoticed.
		const attrs = surfaceAttributes();
		expect(attrs.length).toBeGreaterThan(0);
		expect(attrs).toEqual(expect.arrayContaining(['scheme', 'private']));
	});

	it('has a syncSurfaceChrome call in the very block that writes one', () => {
		// Per BLOCK, not per file. A per-file check cannot catch the regression
		// that happened: the layout that dropped the private re-tint's sync still
		// contained two others, for theme and scheme, so the file passed while the
		// status bar was wrong. Mutation-checked against exactly that edit.
		const offenders: string[] = [];
		let writeSites = 0;
		for (const path of svelteFiles(srcDir)) {
			const text = readFileSync(path, 'utf-8');
			for (const attr of surfaceAttributes()) {
				const camel = attr.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
				const write = new RegExp(
					`dataset\\.${camel}\\b|setAttribute\\(\\s*['"\`]data-${attr}\\b`,
					'g',
				);
				for (const m of text.matchAll(write)) {
					writeSites++;
					if (!enclosingBlock(text, m.index).includes('syncSurfaceChrome(')) {
						offenders.push(`${path.slice(srcDir.length)} (data-${attr})`);
					}
				}
			}
		}
		// The second vacuity guard, and the one that matters if these writes ever
		// move: the scan covers .svelte and .svelte.ts, so relocating them to a
		// plain .ts module would leave `offenders` empty and this test green with
		// zero coverage. (app.html also writes dataset.scheme, deliberately and
		// without a sync — it is the pre-paint script — so the scan must not be
		// widened to .html.)
		expect(writeSites, 'found no surface-attribute writes at all to check').toBeGreaterThan(0);
		expect(
			offenders,
			'this block changes --color-surface, so it must call syncSurfaceChrome() — ' +
				'the sampler carries an inline background that no longer follows the token',
		).toEqual([]);
	});
});

/**
 * The sampler's other silent coupling. `.status-bar-sampler` is written out
 * independently three times — the class in the (auth) layout's markup, the
 * selector in app.css, and a querySelector literal in theme-color.ts — and the
 * lookup is null-guarded, so a rename in one place never throws. It just stops
 * writing the resolved colour, leaving iOS the oklch the stylesheet sets, which
 * is the one failure this whole mechanism exists to avoid and reads at runtime
 * as "the status bar went translucent again" with nothing in the logs.
 *
 * surface-chrome-sampler.test.ts can't cover this: it fabricates an element
 * with the same hardcoded string, so it agrees with theme-color.ts by
 * construction no matter what the real markup says.
 */
describe('status-bar sampler class literal', () => {
	const SAMPLER = 'status-bar-sampler';

	it('is the same literal in the markup, the stylesheet and the query', () => {
		// (auth), not the root layout: inside (app) the mobile top bar is the
		// sampled element and this strip would be redundant on-screen content.
		const layout = readFileSync(`${srcDir}routes/(auth)/+layout.svelte`, 'utf-8');
		const themeColor = readFileSync(`${srcDir}lib/theme-color.ts`, 'utf-8');

		expect(layout, 'the (auth) layout no longer renders the sampler element').toContain(
			`class="${SAMPLER}"`,
		);
		expect(appCss, 'app.css no longer styles the sampler').toContain(`.${SAMPLER}`);
		expect(
			themeColor,
			'theme-color.ts queries a class the markup does not render — the sampler ' +
				'silently keeps the stylesheet oklch that iOS cannot parse',
		).toContain(`querySelector<HTMLElement>('.${SAMPLER}')`);
	});
});
