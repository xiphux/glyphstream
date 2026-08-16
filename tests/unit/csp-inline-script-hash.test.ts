/**
 * Keeps the CSP `script-src` hash in svelte.config.js in step with the inline
 * `<script>` in src/app.html.
 *
 * SvelteKit nonces the scripts it injects but does not hash a user-authored
 * inline script in app.html, so that one is pinned by hand. When the pin goes
 * stale the browser blocks the script — and nothing fails loudly: the page
 * still renders, because the layout re-applies the colour scheme after
 * hydration. What's actually lost is the pre-paint application of
 * `data-scheme` / `data-blur`, i.e. exactly the FOUC the inline script exists
 * to prevent, plus the GPU-blur probe that sets the gs-blur cookie. It shipped
 * stale once, and the only visible evidence was a CSP violation in a console
 * nobody had open.
 *
 * Hashing the raw text between the tags is what the browser does — the
 * expected value it printed in that violation report matched this computation
 * exactly, which is what validates the method here.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const read = (rel: string): string =>
	readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf-8');

describe('CSP inline-script pin', () => {
	it('matches the inline <script> in app.html', () => {
		const appHtml = read('../../src/app.html');
		// The bare `<script>` — attribute-less, so this can't match a future
		// `<script type="module">` or a `src=` tag added alongside it.
		const inline = /<script>([\s\S]*?)<\/script>/.exec(appHtml);
		expect(inline, 'no inline <script> found in app.html').not.toBeNull();

		const expected = `sha256-${createHash('sha256').update(inline![1], 'utf-8').digest('base64')}`;
		const pinned = /'(sha256-[A-Za-z0-9+/=]+)'/.exec(read('../../svelte.config.js'))?.[1];

		expect(
			pinned,
			`CSP hash is stale. Paste this into svelte.config.js script-src: ${expected}`,
		).toBe(expected);
	});

	it('finds exactly one inline script to pin', () => {
		// Two would need two hashes, and the single-hash pin would silently
		// block whichever one wasn't pinned.
		const appHtml = read('../../src/app.html');
		expect(appHtml.match(/<script>/g)?.length ?? 0).toBe(1);
	});
});
