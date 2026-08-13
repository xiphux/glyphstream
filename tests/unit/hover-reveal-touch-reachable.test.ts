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
 * A `sm:` breakpoint is not a fix either: a tablet is `sm:`-and-up AND
 * `hover: none`, so `sm:opacity-0 sm:group-hover:opacity-100` hides the control
 * on exactly the devices that can't bring it back.
 *
 * The fix is the `can-hover` variant in app.css — visible by default, hidden
 * only where a hover can actually restore it. Nothing else catches a
 * regression here: it type-checks, it lints, and a node-env render never
 * evaluates a media query.
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

/** A class list is one `class="…"` / `class={…}` value, split per line. */
function offendingLines(source: string): string[] {
	return source.split('\n').filter((line) => {
		if (!/\bgroup-hover(\/[\w-]+)?:opacity-100/.test(line)) return false;
		// The hidden state must be gated on hover support. A bare `opacity-0`
		// or a breakpoint-gated one is unreachable on touch.
		return /(^|[\s'"`{])opacity-0(?=[\s'"`}])/.test(line) || /\bsm:opacity-0\b/.test(line);
	});
}

describe('hover-revealed controls', () => {
	it('gate their hidden state on `can-hover:`, not a bare `opacity-0` or a breakpoint', () => {
		const offenders: string[] = [];
		for (const file of svelteFiles(SRC)) {
			for (const line of offendingLines(readFileSync(file, 'utf8'))) {
				offenders.push(`${relative(SRC, file)}: ${line.trim()}`);
			}
		}
		expect(offenders).toEqual([]);
	});

	it('detects the anti-pattern it is meant to catch', () => {
		expect(offendingLines('<b class="opacity-0 group-hover:opacity-100">')).toHaveLength(1);
		expect(offendingLines('<b class="sm:opacity-0 sm:group-hover:opacity-100">')).toHaveLength(1);
		expect(offendingLines('<b class="opacity-0 group-hover/row:opacity-100">')).toHaveLength(1);
		// The fixed shape, and unrelated uses of either class, must stay quiet.
		expect(offendingLines('<b class="can-hover:opacity-0 group-hover:opacity-100">')).toEqual([]);
		expect(offendingLines('<b class="opacity-0 transition">')).toEqual([]);
		expect(offendingLines('<b class="group-hover:opacity-100">')).toEqual([]);
	});
});

describe('app.css', () => {
	it('defines the `can-hover` variant the guard above depends on', () => {
		const css = readFileSync(join(SRC, 'app.css'), 'utf8');
		expect(css).toMatch(/@custom-variant\s+can-hover\s+\(@media\s+\(hover:\s*hover\)\)/);
	});
});
