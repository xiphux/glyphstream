/**
 * The shiki output contract that app.css and the streaming→persisted swap rely
 * on, checked against the REAL highlighters on both sides.
 *
 * markdown-render.test.ts only checks for `class="shiki"`, and
 * markdown-live-shiki.test.ts injects a fake highlighter, so the real client
 * subset (shiki/core + the JS regex engine) never loaded in CI. shiki minors
 * auto-merge, and three things would break silently:
 *
 *   - The CSS-variable names. `defaultColor: false` emits `--shiki-light` /
 *     `--shiki-dark` (+ `-bg`), and app.css swaps between them by color scheme.
 *     A rename leaves every code block uncolored, with no error anywhere.
 *   - The client subset's imports and engine. A moved subpath export or a JS
 *     engine that can't compile a grammar makes `ensureLiveHighlighter` resolve
 *     null — which the chat treats as "no highlighting", by design, silently.
 *   - Parity. The live render is swapped for the persisted server HTML when the
 *     turn completes; if the two engines tokenize differently, the code block
 *     visibly re-colors at that moment.
 */
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { renderMarkdown } from '$lib/server/markdown/render';
import {
	ensureLiveHighlighter,
	highlightLiveCode,
	liveHighlighterReady,
	resetLiveHighlighterForTests,
} from '$lib/markdown-live-shiki.svelte';

const PYTHON = [
	'import math',
	'',
	'def area(r: float) -> float:',
	'    """Circle area."""',
	'    return math.pi * r ** 2  # squared',
	'',
	'print(f"{area(2):.2f}", [x for x in range(3)])',
].join('\n');

const MARKDOWN = ['# Title', '', '- **bold** and `code`', '', '[link](https://example.com)'].join(
	'\n',
);

/** The `<pre class="shiki …">…</pre>` block out of a rendered message. */
function preBlock(html: string): string {
	const m = /<pre class="shiki[\s\S]*<\/pre>/.exec(html);
	if (!m) throw new Error(`no shiki block in: ${html}`);
	return m[0];
}

async function serverBlock(code: string, lang: string) {
	return preBlock((await renderMarkdown('```' + lang + '\n' + code + '\n```')) ?? '');
}

beforeAll(async () => {
	resetLiveHighlighterForTests();
	await ensureLiveHighlighter();
}, 30_000);

afterAll(() => {
	resetLiveHighlighterForTests();
});

describe('shiki CSS-variable contract', () => {
	it('server HTML carries the variables app.css reads, and no fixed colors', async () => {
		const pre = await serverBlock(PYTHON, 'python');
		const preStyle = /^<pre[^>]*style="([^"]*)"/.exec(pre)?.[1] ?? '';
		for (const v of ['--shiki-light', '--shiki-dark', '--shiki-light-bg', '--shiki-dark-bg']) {
			expect(preStyle).toMatch(new RegExp(`(^|;)${v}:`));
		}
		const spanStyles = [...pre.matchAll(/<span style="([^"]*)"/g)].map((m) => m[1]);
		expect(spanStyles.length).toBeGreaterThan(5);
		for (const s of spanStyles) expect(s).toMatch(/--shiki-light:.*--shiki-dark:/);
		// defaultColor:false means no bare `color:` — a theme default baked inline
		// would override the scheme swap.
		expect(pre).not.toMatch(/[";]\s*(background-)?color:/);
	});

	it('app.css still reads exactly those variable names', () => {
		const css = readFileSync(new URL('../../src/app.css', import.meta.url), 'utf8');
		for (const v of ['--shiki-light', '--shiki-dark', '--shiki-light-bg', '--shiki-dark-bg']) {
			expect(css).toContain(`var(${v})`);
		}
		expect(css).toContain('pre.shiki');
	});
});

describe('client live-highlighting subset (real shiki/core + JS engine)', () => {
	it('loads', () => {
		expect(liveHighlighterReady.value).toBe(true);
	});

	it.each([
		['python', PYTHON],
		['markdown', MARKDOWN],
	] as const)('highlights %s identically to the server', async (lang, code) => {
		// markdown-it hands `highlight` the fence body with its trailing newline.
		const live = highlightLiveCode(code + '\n', lang);
		expect(live).not.toBeNull();
		// Actually tokenized, not a single uncolored run.
		expect(new Set(live!.match(/--shiki-light:#[0-9a-fA-F]+/g)).size).toBeGreaterThan(2);
		expect(live).toBe(await serverBlock(code, lang));
	});
});
