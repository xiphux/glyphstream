/**
 * Holds the line on hover-revealed controls staying reachable on touch.
 *
 * Tailwind v4 wraps every `hover:` / `group-hover:` variant in
 * `@media (hover: hover)`. On a touch device that block is never emitted, so a
 * control hidden by a bare `opacity-0` and revealed only by `group-hover:` is
 * not merely hard to reach — it is permanently invisible while still holding
 * its hit area. That is how the memories page's Forget button and the archive
 * page's overflow menu became unusable in the iOS PWA.
 *
 * A breakpoint is not a fix either: a tablet is `sm:`-and-up AND `hover: none`,
 * so `sm:opacity-0 sm:group-hover:opacity-100` hides the control on exactly the
 * devices that can't bring it back. Every breakpoint is checked, not just `sm:`.
 *
 * The fix is the `can-hover` variant in app.css — visible by default, hidden
 * only where a hover can actually restore it. Nothing else catches a
 * regression here: it type-checks, it lints, and a node-env render never
 * evaluates a media query.
 *
 * Scope, deliberately bounded — this guard covers OPACITY-hidden controls, and
 * matches per class attribute rather than per line so a multi-line `class={[…]}`
 * array can't slip through (14 files use that idiom). It does NOT flag the other
 * spelling, `hidden` + `group-hover/x:block`. The only two instances of that in
 * the tree are informational tooltips (`ModelPicker`'s compare-cart preview and
 * `SplitAttachmentsToggle`'s), which are correctly desktop-only: they convey no
 * affordance a touch user needs, and there is nothing to reach. Flagging them
 * would need a control-vs-tooltip discriminator, and the guard would spend its
 * accuracy fighting the tree for a spelling nobody reaches for — you use opacity
 * when you want the transition. If a real CONTROL is ever hidden with `hidden`,
 * this test will not catch it.
 */

import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const SRC = resolve(__dirname, '../../src');

function svelteFiles(dir: string): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) out.push(...svelteFiles(full));
		else if (entry.name.endsWith('.svelte')) out.push(full);
	}
	return out;
}

/**
 * Every `class=` / `…Class=` value in a component, whitespace-collapsed to a
 * single line and space-padded so word-boundary checks work at either end.
 * Reading the whole attribute is the point: the hidden state and its reveal
 * routinely sit on different lines of a `class={[…]}` array or a wrapped
 * string, and a per-line scan sees neither next to the other.
 */
function classValues(source: string): string[] {
	const out: string[] = [];
	// `class=`, plus component props like `contentClass=`. `class:foo={…}`
	// directives are skipped — `class` is followed by `:` there, not `=`.
	const attr = /(?:^|[\s{])(?:[A-Za-z]+)?[Cc]lass=/g;
	let m: RegExpExecArray | null;
	while ((m = attr.exec(source)) !== null) {
		const start = m.index + m[0].length;
		const open = source[start];
		let raw: string;
		if (open === '"' || open === "'") {
			const end = source.indexOf(open, start + 1);
			if (end === -1) continue;
			raw = source.slice(start + 1, end);
			attr.lastIndex = end + 1;
		} else if (open === '{') {
			// Balanced-brace scan, so a nested `{…}` inside the expression
			// (ternaries, template literals) doesn't end the value early.
			let depth = 0;
			let j = start;
			for (; j < source.length; j++) {
				if (source[j] === '{') depth++;
				else if (source[j] === '}' && --depth === 0) break;
			}
			if (j >= source.length) continue;
			raw = source.slice(start + 1, j);
			attr.lastIndex = j + 1;
		} else {
			continue;
		}
		out.push(` ${raw.replace(/\s+/g, ' ').trim()} `);
	}
	return out;
}

function offendingClassValues(source: string): string[] {
	return classValues(source).filter((value) => {
		if (!/\bgroup-hover(\/[\w-]+)?:opacity-100/.test(value)) return false;
		// The hidden state must be gated on hover support. A bare `opacity-0`,
		// or one gated on any breakpoint, is unreachable on touch.
		return (
			/[\s'"`]opacity-0(?=[\s'"`])/.test(value) || /\b(?:sm|md|lg|xl|2xl):opacity-0\b/.test(value)
		);
	});
}

describe('hover-revealed controls', () => {
	it('gate their hidden state on `can-hover:`, not a bare `opacity-0` or a breakpoint', () => {
		const offenders: string[] = [];
		for (const file of svelteFiles(SRC)) {
			for (const value of offendingClassValues(readFileSync(file, 'utf8'))) {
				offenders.push(`${relative(SRC, file)}: ${value.trim().slice(0, 120)}`);
			}
		}
		expect(offenders).toEqual([]);
	});

	it('detects the anti-pattern it is meant to catch', () => {
		expect(offendingClassValues('<b class="opacity-0 group-hover:opacity-100">')).toHaveLength(1);
		expect(offendingClassValues('<b class="opacity-0 group-hover/row:opacity-100">')).toHaveLength(
			1,
		);
		// Every breakpoint, not just `sm:` — a tablet clears `md:` too.
		for (const bp of ['sm', 'md', 'lg', 'xl', '2xl']) {
			expect(
				offendingClassValues(`<b class="${bp}:opacity-0 ${bp}:group-hover:opacity-100">`),
			).toHaveLength(1);
		}
		// The whole point of reading per attribute: these two shapes put the
		// hidden state and its reveal on different lines.
		expect(
			offendingClassValues('<b\n\tclass="opacity-0 transition\n\tgroup-hover:opacity-100"\n>'),
		).toHaveLength(1);
		expect(
			offendingClassValues(
				"<b\n\tclass={[\n\t\t'opacity-0 transition',\n\t\tcond && 'group-hover:opacity-100',\n\t]}\n>",
			),
		).toHaveLength(1);
		// A value ending in the bare class, with no trailing token to bound it.
		expect(offendingClassValues('<b class="group-hover:opacity-100 opacity-0">')).toHaveLength(1);
	});

	it('stays quiet on the fixed shape and on unrelated uses', () => {
		expect(offendingClassValues('<b class="can-hover:opacity-0 group-hover:opacity-100">')).toEqual(
			[],
		);
		expect(
			offendingClassValues(
				"<b\n\tclass={[\n\t\t'can-hover:opacity-0',\n\t\t'group-hover/row:opacity-100',\n\t]}\n>",
			),
		).toEqual([]);
		expect(offendingClassValues('<b class="opacity-0 transition">')).toEqual([]);
		expect(offendingClassValues('<b class="group-hover:opacity-100">')).toEqual([]);
		// `opacity-0` as a substring of another utility must not count.
		expect(offendingClassValues('<b class="opacity-05 group-hover:opacity-100">')).toEqual([]);
		// A `class:` directive is not a class list.
		expect(offendingClassValues('<b class:opacity-0={x} class="group-hover:opacity-100">')).toEqual(
			[],
		);
	});
});

describe('app.css', () => {
	it('defines the `can-hover` variant the guard above depends on', () => {
		const css = readFileSync(join(SRC, 'app.css'), 'utf8');
		expect(css).toMatch(/@custom-variant\s+can-hover\s+\(@media\s+\(hover:\s*hover\)\)/);
	});
});
