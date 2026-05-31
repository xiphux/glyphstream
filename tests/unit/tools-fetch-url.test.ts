import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock node:dns BEFORE importing the tool so the module picks up the mock.
const lookupMock = vi.hoisted(() => vi.fn());
vi.mock('node:dns', () => ({
	default: { promises: { lookup: lookupMock } },
	promises: { lookup: lookupMock },
}));

import { fetchUrlTool, isPrivateIp, extractTextFromHtml } from '$lib/server/tools/fetch-url';
import type { ToolContext } from '$lib/server/tools/types';

function ctx(): ToolContext {
	return {
		userId: 'u1',
		conversationId: 'c1',
		signal: new AbortController().signal,
		disabledFeatures: [],
	};
}

function publicResolves() {
	// 8.8.8.8 is globally routable; isPrivateIp returns false for it.
	lookupMock.mockResolvedValue([{ address: '8.8.8.8', family: 4 }]);
}

function privateResolves() {
	lookupMock.mockResolvedValue([{ address: '192.168.1.10', family: 4 }]);
}

const realFetch = globalThis.fetch;

beforeEach(() => {
	lookupMock.mockReset();
});

afterEach(() => {
	globalThis.fetch = realFetch;
});

describe('fetch_url tool definition', () => {
	it('exposes the expected OpenAI function schema', () => {
		expect(fetchUrlTool.definition.function.name).toBe('fetch_url');
		expect(fetchUrlTool.definition.function.parameters).toMatchObject({
			type: 'object',
			properties: { url: { type: 'string' } },
			required: ['url'],
			additionalProperties: false,
		});
	});

	it('is always available (no isAvailable predicate)', () => {
		expect(fetchUrlTool.isAvailable).toBeUndefined();
	});
});

describe('fetch_url argument validation', () => {
	it('returns isError when url is missing', async () => {
		const r = await fetchUrlTool.execute({}, ctx());
		expect(r.isError).toBe(true);
		expect(JSON.parse(r.content).error).toMatch(/url/i);
	});

	it('returns isError for non-string url', async () => {
		const r = await fetchUrlTool.execute({ url: 123 }, ctx());
		expect(r.isError).toBe(true);
	});

	it('returns isError for empty string url', async () => {
		const r = await fetchUrlTool.execute({ url: '' }, ctx());
		expect(r.isError).toBe(true);
	});

	it('returns isError for malformed url', async () => {
		const r = await fetchUrlTool.execute({ url: 'not a url' }, ctx());
		expect(r.isError).toBe(true);
		expect(JSON.parse(r.content).error).toMatch(/valid URL/i);
	});
});

describe('fetch_url scheme guards', () => {
	it('refuses file://', async () => {
		const r = await fetchUrlTool.execute({ url: 'file:///etc/passwd' }, ctx());
		expect(r.isError).toBe(true);
		expect(JSON.parse(r.content).error).toMatch(/scheme/i);
	});

	it('refuses data:', async () => {
		const r = await fetchUrlTool.execute({ url: 'data:text/plain,hi' }, ctx());
		expect(r.isError).toBe(true);
	});

	it('refuses ftp:', async () => {
		const r = await fetchUrlTool.execute({ url: 'ftp://example.com/file' }, ctx());
		expect(r.isError).toBe(true);
	});
});

describe('fetch_url SSRF guard', () => {
	it('refuses URLs whose DNS resolves to private IPv4', async () => {
		privateResolves();
		const r = await fetchUrlTool.execute({ url: 'http://intranet.example/' }, ctx());
		expect(r.isError).toBe(true);
		expect(JSON.parse(r.content).error).toMatch(/192\.168\.1\.10/);
	});

	it('refuses 169.254.169.254 (AWS metadata)', async () => {
		lookupMock.mockResolvedValue([{ address: '169.254.169.254', family: 4 }]);
		const r = await fetchUrlTool.execute(
			{ url: 'http://169.254.169.254/latest/meta-data/' },
			ctx(),
		);
		expect(r.isError).toBe(true);
	});

	it('refuses redirects whose Location resolves to private IP', async () => {
		// First lookup: public. Second lookup (after redirect): private.
		lookupMock
			.mockResolvedValueOnce([{ address: '8.8.8.8', family: 4 }])
			.mockResolvedValueOnce([{ address: '10.0.0.1', family: 4 }]);
		globalThis.fetch = vi.fn(async (input: any) => {
			const u = String(input);
			if (u.startsWith('http://public.example')) {
				return new Response(null, {
					status: 302,
					headers: { location: 'http://intranet.example/admin' },
				});
			}
			throw new Error('should not fetch private host');
		}) as any;
		const r = await fetchUrlTool.execute({ url: 'http://public.example/' }, ctx());
		expect(r.isError).toBe(true);
		expect(JSON.parse(r.content).error).toMatch(/10\.0\.0\.1/);
	});
});

describe('fetch_url HTML extraction', () => {
	it('extracts readable text, strips script/style, decodes entities', async () => {
		publicResolves();
		globalThis.fetch = vi.fn(
			async () =>
				new Response(
					`<html><head><title>x</title></head><body>
				<script>alert("evil")</script>
				<style>.x{color:red}</style>
				<h1>Hello &amp; World</h1>
				<p>Line one.</p>
				<p>Line two &lt;b&gt;.</p>
				</body></html>`,
					{ status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } },
				),
		) as any;

		const r = await fetchUrlTool.execute({ url: 'http://example.com/' }, ctx());
		expect(r.isError).toBeUndefined();
		const parsed = JSON.parse(r.content);
		expect(parsed.status).toBe(200);
		expect(parsed.content_type).toMatch(/text\/html/);
		expect(parsed.content).toContain('Hello & World');
		expect(parsed.content).toContain('Line one.');
		expect(parsed.content).toContain('Line two <b>.');
		expect(parsed.content).not.toContain('alert');
		expect(parsed.content).not.toContain('color:red');
		expect(parsed.content).not.toContain('<h1>');
	});

	it('passes text/plain through unchanged', async () => {
		publicResolves();
		globalThis.fetch = vi.fn(
			async () =>
				new Response('just some plain text\nwith two lines', {
					status: 200,
					headers: { 'content-type': 'text/plain' },
				}),
		) as any;
		const r = await fetchUrlTool.execute({ url: 'http://example.com/foo.txt' }, ctx());
		expect(r.isError).toBeUndefined();
		expect(JSON.parse(r.content).content).toBe('just some plain text\nwith two lines');
	});

	it('passes application/json through as-is', async () => {
		publicResolves();
		globalThis.fetch = vi.fn(
			async () =>
				new Response('{"a":1,"b":[2,3]}', {
					status: 200,
					headers: { 'content-type': 'application/json' },
				}),
		) as any;
		const r = await fetchUrlTool.execute({ url: 'http://api.example/' }, ctx());
		expect(r.isError).toBeUndefined();
		const content = JSON.parse(r.content).content;
		expect(content).toBe('{"a":1,"b":[2,3]}');
	});

	it('rejects unsupported binary content types', async () => {
		publicResolves();
		globalThis.fetch = vi.fn(
			async () =>
				new Response(new Uint8Array([0, 1, 2]), {
					status: 200,
					headers: { 'content-type': 'image/png' },
				}),
		) as any;
		const r = await fetchUrlTool.execute({ url: 'http://example.com/x.png' }, ctx());
		expect(r.isError).toBe(true);
		expect(JSON.parse(r.content).error).toMatch(/image\/png/);
	});

	it('caps the response body at 2 MB', async () => {
		publicResolves();
		// 3 MB of data — exceeds the 2 MB cap
		const big = new Uint8Array(3 * 1024 * 1024).fill(65);
		globalThis.fetch = vi.fn(
			async () => new Response(big, { status: 200, headers: { 'content-type': 'text/plain' } }),
		) as any;
		const r = await fetchUrlTool.execute({ url: 'http://example.com/' }, ctx());
		expect(r.isError).toBe(true);
		expect(JSON.parse(r.content).error).toMatch(/exceeded/i);
	});

	it('uses Readability to extract article text + title, dropping site chrome', async () => {
		publicResolves();
		// Article-shaped HTML so Readability identifies it (needs enough text
		// content to clear its internal threshold; 200+ chars of body prose).
		const articleHtml = `<!doctype html>
<html><head>
  <title>Best Bread of 2026</title>
  <meta charset="utf-8">
</head><body>
  <nav><a href="/">Home</a><a href="/about">About</a><a href="/contact">Contact</a></nav>
  <header><div>Site banner ad goes here</div></header>
  <aside><div>Sidebar widgets and unrelated links</div></aside>
  <article>
    <h1>Best Bread of 2026</h1>
    <p>Sourdough has continued its decade-long ascent through 2026, with bakers
       around the world refining hydration techniques and embracing longer
       fermentation windows than ever before. The renewed interest in heritage
       grains has pushed millers to source rye, einkorn, and emmer in
       quantities not seen since the early twentieth century.</p>
    <p>The standout bread of the year is a hundred-percent stoneground rye
       loaf from a small bakery in Copenhagen, distinguished by its deep
       molasses crust and almost custardy crumb. Judges noted the balance
       between sour and sweet, and the long finish that lingered after every
       bite. Worth the trip if you ever find yourself in the city.</p>
  </article>
  <footer><div>Comments, related posts, ad tracker scripts</div></footer>
  <script>analytics.fire()</script>
</body></html>`;
		globalThis.fetch = vi.fn(
			async () =>
				new Response(articleHtml, {
					status: 200,
					headers: { 'content-type': 'text/html; charset=utf-8' },
				}),
		) as any;

		const r = await fetchUrlTool.execute({ url: 'http://blog.example/best-bread' }, ctx());
		expect(r.isError).toBeUndefined();
		const parsed = JSON.parse(r.content);
		expect(parsed.content).toContain('Best Bread of 2026');
		expect(parsed.content).toContain('Sourdough has continued');
		expect(parsed.content).toContain('Copenhagen');
		// Site chrome that Readability should have stripped:
		expect(parsed.content).not.toContain('Site banner');
		expect(parsed.content).not.toContain('Sidebar widgets');
		expect(parsed.content).not.toContain('Comments, related posts');
		expect(parsed.content).not.toContain('analytics.fire');
	});

	it('falls back to regex extraction when Readability finds no article', async () => {
		publicResolves();
		// Short, non-article HTML — Readability will return null or trivial
		// content; we should still get something usable from the regex path.
		globalThis.fetch = vi.fn(
			async () =>
				new Response('<html><body><h1>Hello &amp; World</h1><p>Short page.</p></body></html>', {
					status: 200,
					headers: { 'content-type': 'text/html' },
				}),
		) as any;
		const r = await fetchUrlTool.execute({ url: 'http://example.com/' }, ctx());
		expect(r.isError).toBeUndefined();
		const parsed = JSON.parse(r.content);
		expect(parsed.content).toContain('Hello & World');
		expect(parsed.content).toContain('Short page.');
	});

	it('truncates extracted text to 20 KB and flags truncated', async () => {
		publicResolves();
		const big = 'a'.repeat(25_000);
		globalThis.fetch = vi.fn(
			async () => new Response(big, { status: 200, headers: { 'content-type': 'text/plain' } }),
		) as any;
		const r = await fetchUrlTool.execute({ url: 'http://example.com/' }, ctx());
		expect(r.isError).toBeUndefined();
		const parsed = JSON.parse(r.content);
		expect(parsed.content.length).toBe(20_000);
		expect(parsed.truncated).toBe(true);
	});

	it('follows up to 3 redirects then errors', async () => {
		publicResolves();
		// Resolve every hop as 8.8.8.8 so DNS isn't the failure mode.
		lookupMock.mockResolvedValue([{ address: '8.8.8.8', family: 4 }]);
		let hop = 0;
		globalThis.fetch = vi.fn(async () => {
			hop++;
			return new Response(null, {
				status: 302,
				headers: { location: `http://example.com/hop${hop}` },
			});
		}) as any;
		const r = await fetchUrlTool.execute({ url: 'http://example.com/' }, ctx());
		expect(r.isError).toBe(true);
		expect(JSON.parse(r.content).error).toMatch(/redirect/i);
	});

	it('returns the final URL after redirect chase', async () => {
		lookupMock.mockResolvedValue([{ address: '8.8.8.8', family: 4 }]);
		globalThis.fetch = vi.fn(async (input: any) => {
			const u = String(input);
			if (u.endsWith('/start')) {
				return new Response(null, {
					status: 301,
					headers: { location: 'http://example.com/end' },
				});
			}
			return new Response('done', {
				status: 200,
				headers: { 'content-type': 'text/plain' },
			});
		}) as any;
		const r = await fetchUrlTool.execute({ url: 'http://example.com/start' }, ctx());
		expect(r.isError).toBeUndefined();
		const parsed = JSON.parse(r.content);
		expect(parsed.url).toBe('http://example.com/end');
		expect(parsed.content).toBe('done');
	});
});

describe('isPrivateIp', () => {
	const privateCases = [
		'10.0.0.1',
		'10.255.255.255',
		'127.0.0.1',
		'127.1.2.3',
		'169.254.169.254',
		'172.16.0.1',
		'172.31.255.255',
		'192.168.0.1',
		'192.168.100.50',
		'100.64.0.1',
		'198.18.0.1',
		'224.0.0.1',
		'240.0.0.1',
		'0.0.0.0',
		'::1',
		'::',
		'fc00::1',
		'fd12:3456::1',
		'fe80::1',
		'ff02::1',
		'::ffff:127.0.0.1',
		'::ffff:10.0.0.1',
	];
	for (const ip of privateCases) {
		it(`rejects ${ip}`, () => expect(isPrivateIp(ip)).toBe(true));
	}

	const publicCases = [
		'8.8.8.8',
		'1.1.1.1',
		'93.184.216.34',
		'2606:4700:4700::1111',
		'2001:4860:4860::8888',
	];
	for (const ip of publicCases) {
		it(`allows ${ip}`, () => expect(isPrivateIp(ip)).toBe(false));
	}

	it('fails closed on garbage input', () => {
		expect(isPrivateIp('')).toBe(true);
		expect(isPrivateIp('hello')).toBe(true);
		expect(isPrivateIp('999.999.999.999')).toBe(true);
		expect(isPrivateIp('1.2.3')).toBe(true);
	});

	it('handles IPv6 zone suffixes', () => {
		expect(isPrivateIp('fe80::1%eth0')).toBe(true);
	});
});

describe('extractTextFromHtml', () => {
	it('drops script and style blocks completely', () => {
		const out = extractTextFromHtml(
			'<p>before</p><script>bad()</script><p>after</p><style>p{}</style>',
		);
		expect(out).not.toContain('bad');
		expect(out).not.toContain('p{}');
		expect(out).toContain('before');
		expect(out).toContain('after');
	});

	it('decodes named and numeric entities', () => {
		const out = extractTextFromHtml('<p>&amp; &lt; &gt; &quot; &apos; &nbsp; &#65; &#x41;</p>');
		// nbsp decodes to space, then runs of spaces collapse to one.
		expect(out).toBe('& < > " \' A A');
	});

	it('drops HTML comments', () => {
		expect(extractTextFromHtml('<p>hi <!-- secret --> there</p>')).toBe('hi there');
	});

	it('preserves paragraph breaks but collapses runs of whitespace', () => {
		const out = extractTextFromHtml('<p>one</p>\n\n\n<p>two</p>     <p>three</p>');
		expect(out).toBe('one\n\ntwo\n\nthree');
	});

	it('strips unknown tags without their content', () => {
		expect(extractTextFromHtml('<custom-tag attr="x">visible</custom-tag>')).toContain('visible');
	});
});
