/**
 * fetch_url on hostile markup (audit S2). Extraction of up to 2 MB of
 * attacker-served HTML used to run synchronously on the server's only event
 * loop, superlinear in two independent stages:
 *
 *   - the tag-stripping fallback's regexes rescanned to the end of the input
 *     from every unterminated `<!--` / `<svg ` / `<` opener (256 KB: ~30 s);
 *   - linkedom + Readability on deeply nested unclosed elements (64 KB of
 *     `<div>`: 40–90 s), which no amount of regex work can make linear.
 *
 * The fallback must now be linear on its own, and the whole extraction must
 * run where a deadline can stop it: the tool returns an error the model sees,
 * and the event loop keeps ticking meanwhile.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FetchResult } from '#lib/server/tools/fetch-url.js';

const lookupMock = vi.hoisted(() => vi.fn());
vi.mock('node:dns', () => ({
	default: { promises: { lookup: lookupMock } },
	promises: { lookup: lookupMock },
}));

import {
	extractArticleStructured,
	extractTextFromHtml,
	fetchUrlTool,
} from '#lib/server/tools/fetch-url.js';
import {
	EXTRACT_TIMEOUT_MESSAGE,
	setExtractBudgetForTests,
} from '#lib/server/tools/extract-in-worker.js';

const realFetch = globalThis.fetch;

beforeEach(() => {
	lookupMock.mockReset().mockResolvedValue([{ address: '8.8.8.8', family: 4 }]);
});

afterEach(() => {
	globalThis.fetch = realFetch;
	setExtractBudgetForTests();
});

const page = (unit: string, kb: number) => unit.repeat(Math.floor((kb * 1024) / unit.length));

function time(fn: () => unknown): number {
	const t0 = performance.now();
	fn();
	return performance.now() - t0;
}

function serveHtml(html: string) {
	globalThis.fetch = vi.fn(
		async () =>
			new Response(html, {
				status: 200,
				headers: { 'content-type': 'text/html; charset=utf-8' },
			}),
	);
}

type FetchPayload = FetchResult & { error?: string };

/** Run the tool while a 10 ms interval counts how often the event loop got a turn. */
async function executeCountingTicks(signal: AbortSignal) {
	let ticks = 0;
	const interval = setInterval(() => ticks++, 10);
	const t0 = performance.now();
	try {
		const r = await fetchUrlTool.execute(
			{ url: 'http://example.com/hostile' },
			{ userId: 'u1', conversationId: 'c1', signal, disabledFeatures: [] },
		);
		return { r, ms: performance.now() - t0, ticks };
	} finally {
		clearInterval(interval);
	}
}

const SHAPES = [
	['unterminated comments', '<!--'],
	['unterminated <svg> openers', '<svg '],
	['unclosed <div> nesting', '<div>'],
	['unclosed <a> nesting', '<a href="x">t, '],
	['bare < with no >', '<'],
] as const;

describe('extractTextFromHtml is linear on hostile markup', () => {
	for (const [name, unit] of SHAPES) {
		it(`${name}: 256 KB in well under a second`, () => {
			const ms = time(() => extractTextFromHtml(page(unit, 256)));
			expect(ms).toBeLessThan(1000);
		}, 120_000);

		it(`${name}: quadrupling the input does not multiply the time by sixteen`, () => {
			// Warm the JIT, then take the best of three so a GC pause can't fail it.
			// A 4x step keeps linear (~4x) and quadratic (~16x) far apart, so a
			// loaded machine running the suite in parallel can't blur them.
			extractTextFromHtml(page(unit, 64));
			const best = (kb: number) =>
				Math.min(...[0, 1, 2].map(() => time(() => extractTextFromHtml(page(unit, kb)))));
			const small = best(256);
			const large = best(1024);
			expect(large / Math.max(small, 1)).toBeLessThan(8);
		}, 120_000);
	}

	it('the comment and <svg> shapes really are the fallback path', () => {
		expect(extractArticleStructured(page('<!--', 16))).toBeNull();
		expect(extractArticleStructured(page('<svg ', 16))).toBeNull();
	});
});

/**
 * The regex passes the linear scans replace, verbatim: on input small enough
 * for their quadratic cost not to matter they are the spec.
 */
function regexPasses(html: string): string {
	return html
		.replace(/<!--[\s\S]*?-->/g, '')
		.replace(
			/<(script|style|head|nav|footer|aside|noscript|template|svg|iframe)\b[^>]*>[\s\S]*?<\/\1\s*>/gi,
			'',
		)
		.replace(/<(?:br|hr)\s*\/?>/gi, '\n')
		.replace(/<\/(?:p|div|li|tr|h[1-6]|section|article|header|blockquote|pre)\s*>/gi, '\n\n')
		.replace(/<\/(?:td|th)\s*>/gi, '\t')
		.replace(/<\/?[^>]+>/g, ' ');
}

/** Same post-processing as extractTextFromHtml, minus entity decoding (no `&` is generated). */
function regexReference(html: string): string {
	return regexPasses(html)
		.replace(/[ \t]+/g, ' ')
		.replace(/ ?\n ?/g, '\n')
		.replace(/\n{3,}/g, '\n\n')
		.trim();
}

describe('extractTextFromHtml matches the regexes it replaced', () => {
	const cases = [
		'<p>hi <!-- a --> there <!-- b --> end</p>',
		'<!-->x-->y<!--z',
		'a<!--b',
		'<SCRIPT type="x">var a = "</p>";</script >after',
		'<svg><svg>inner</svg>tail</svg>more',
		'<style>a{}</STYLE>x<style>unclosed',
		'<scripted>kept</scripted><script-x>gone</script-x>',
		'<nav class="a>b">menu</nav>body',
		'<head><title>t</title></head><body>x</body>',
		'<svg  <svg>q</svg>r',
		'<> </> < a> <b x="1" <c> d>',
		'1 < 2 and 3 > 2',
		'<template><svg>x</template>y</svg>z',
		'<td>a</td><th>b</TH><br/><hr ><BR>',
		'<iframe src=x></iframe><aside>s</aside><footer>f</footer><noscript>n</noscript>',
	];
	for (const html of cases) {
		it(JSON.stringify(html), () => {
			expect(extractTextFromHtml(html)).toBe(regexReference(html));
		});
	}

	it('agrees on random tag soup', () => {
		const tokens = [
			'<',
			'>',
			'/',
			'<!--',
			'-->',
			'-',
			'!',
			' ',
			'\n',
			'x',
			'svg',
			'SVG',
			'script',
			'style',
			'nav',
			'<svg',
			'</svg>',
			'</svg',
			'<script>',
			'</script>',
			'<p>',
			'</p>',
			'<br>',
			'</td>',
			'<div ',
			'</div>',
			'"',
		];
		let seed = 0x5eed;
		const rand = (n: number) => {
			seed = (seed * 1103515245 + 12345) & 0x7fffffff;
			return seed % n;
		};
		for (let i = 0; i < 3000; i++) {
			let html = '';
			const len = 1 + rand(40);
			for (let j = 0; j < len; j++) html += tokens[rand(tokens.length)];
			expect(extractTextFromHtml(html), JSON.stringify(html)).toBe(regexReference(html));
		}
	});
});

describe('fetch_url extraction cannot block the event loop', () => {
	it('a pathological Readability page becomes a tool error at the extraction budget', async () => {
		setExtractBudgetForTests(400);
		serveHtml(page('<div>', 64));
		const { r, ms, ticks } = await executeCountingTicks(new AbortController().signal);
		expect(r.isError).toBe(true);
		expect((JSON.parse(r.content) as FetchPayload).error).toBe(EXTRACT_TIMEOUT_MESSAGE);
		expect(ms).toBeLessThan(3000);
		// ~40 ticks fit in 400 ms; a blocked loop gets none until it's over.
		expect(ticks).toBeGreaterThan(10);
	}, 120_000);

	it('the tool deadline (ctx.signal) stops extraction before the budget does', async () => {
		serveHtml(page('<a href="x">t, ', 64));
		const { r, ms, ticks } = await executeCountingTicks(AbortSignal.timeout(300));
		expect(r.isError).toBe(true);
		expect((JSON.parse(r.content) as FetchPayload).error).toBe(EXTRACT_TIMEOUT_MESSAGE);
		expect(ms).toBeLessThan(3000);
		expect(ticks).toBeGreaterThan(10);
	}, 120_000);

	it('a normal article still comes back whole', async () => {
		const para = '<p>Readable article prose, long enough that Readability keeps it.</p>';
		serveHtml(
			`<html><head><title>Doc</title></head><body><article><h1>Doc</h1>${para.repeat(8)}</article></body></html>`,
		);
		const { r } = await executeCountingTicks(new AbortController().signal);
		expect(r.isError).toBeUndefined();
		const p = JSON.parse(r.content) as FetchPayload;
		expect(p.mode).toBe('full');
		expect(p.content).toContain('Readable article prose');
	});
});
