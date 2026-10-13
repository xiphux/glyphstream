/**
 * Both markdown renderers feed `{@html}`, so their escaping is the XSS
 * boundary for everything a model writes. The renderer tests only checked
 * that a raw `<script>` is escaped; these pin the other ways markdown can
 * emit live HTML — link schemes, fence info strings, code bodies — so a
 * markdown-it major bump or an `html: true` slipping in fails here.
 *
 * The same cases run through the server renderer (markdown-it + full shiki)
 * and the live streaming renderer, both with and without its lazy shiki
 * subset loaded, since each of those emits code blocks differently.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { renderMarkdown } from '#lib/server/markdown/render.js';
import { ensureLiveMarkdown, renderLiveMarkdown } from '#lib/markdown-live.js';
import {
	ensureLiveHighlighter,
	resetLiveHighlighterForTests,
} from '#lib/markdown-live-shiki.svelte.js';

type Render = (md: string) => Promise<string>;

const renderers: Array<[string, Render, (() => Promise<void>)?]> = [
	['server', async (md) => (await renderMarkdown(md)) ?? ''],
	['live, plain code', async (md) => Promise.resolve(renderLiveMarkdown(md))],
	[
		'live, highlighted code',
		async (md) => Promise.resolve(renderLiveMarkdown(md)),
		async () => {
			expect(await ensureLiveHighlighter()).not.toBeNull();
		},
	],
];

/** No element the input could have smuggled in, and no live handler. */
function expectInert(html: string): void {
	expect(html).not.toMatch(/<(script|img|iframe|svg|object|embed|style)\b/i);
	// A handler attribute on a real tag; escaped text may mention one freely.
	expect(html).not.toMatch(/<[a-z][^>]*\son[a-z]+\s*=/i);
}

beforeAll(async () => {
	await ensureLiveMarkdown();
});

afterAll(() => {
	resetLiveHighlighterForTests();
});

describe.each(renderers)('%s renderer', (_name, render, setup) => {
	beforeAll(async () => {
		resetLiveHighlighterForTests();
		if (setup) await setup();
	});

	it.each([
		'[x](javascript:alert(1))',
		'[x](JAVASCRIPT:alert(1))',
		'[x](java\tscript:alert(1))',
		'[x](vbscript:msgbox(1))',
		'[x](data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==)',
		'<javascript:alert(1)>',
		'![x](javascript:alert(1))',
	])('never emits a dangerous-scheme href or src: %s', async (md) => {
		const html = await render(md);
		expect(html).not.toMatch(/(href|src)="\s*(javascript|vbscript|data:text)/i);
		expectInert(html);
	});

	it('keeps an ordinary https link', async () => {
		expect(await render('[x](https://example.com/a?b=1&c=2)')).toContain(
			'href="https://example.com/a?b=1&amp;c=2"',
		);
	});

	it('escapes a link title and text', async () => {
		const html = await render(
			'[<img src=x onerror=alert(1)>](https://e.com "a\\" onmouseover=\\"x")',
		);
		// The quote stays inside the title value; the handler never becomes
		// an attribute of its own.
		expect(html).toContain('title="a&quot; onmouseover=&quot;x"');
		expect(html).not.toMatch(/<(img|script)\b/i);
	});

	it.each(['python', 'unknownlang', ''])('escapes markup in a %s fence body', async (lang) => {
		const html = await render(
			'```' + lang + '\n<script>alert(1)</script>\n<img src=x onerror=y>\n```',
		);
		expectInert(html);
		// shiki escapes `<` as `&#x3C;`, markdown-it as `&lt;`.
		expect(html).toMatch(/&lt;|&#x3C;/);
	});

	it('escapes a hostile fence info string', async () => {
		const html = await render('```"><script>alert(1)</script>\ncode\n```');
		expectInert(html);
		expect(html).not.toContain('"><');
	});

	it('escapes raw HTML blocks and inline tags', async () => {
		const html = await render('<div onclick="x">hi</div>\n\ntext <svg onload=alert(1)>');
		expectInert(html);
	});

	it('escapes markup inside inline code', async () => {
		const html = await render('`<script>alert(1)</script>`');
		expectInert(html);
		expect(html).toContain('&lt;script&gt;');
	});
});
