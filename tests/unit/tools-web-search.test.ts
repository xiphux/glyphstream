import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock the config loader so we can control what `[search]` looks like.
const loadSearchConfigMock = vi.hoisted(() => vi.fn());
vi.mock('$lib/server/endpoints/config', () => ({
	loadSearchConfig: loadSearchConfigMock,
}));

import { webSearchTool, _resetConfigCacheForTests } from '$lib/server/tools/web-search';
import type { ToolContext } from '$lib/server/tools/types';

function ctx(): ToolContext {
	return {
		userId: 'u1',
		conversationId: 'c1',
		signal: new AbortController().signal,
		disabledFeatures: [],
	};
}

const realFetch = globalThis.fetch;

beforeEach(() => {
	loadSearchConfigMock.mockReset();
	_resetConfigCacheForTests();
});

afterEach(() => {
	globalThis.fetch = realFetch;
});

describe('web_search tool definition', () => {
	it('has the expected OpenAI function schema', () => {
		expect(webSearchTool.definition.function.name).toBe('web_search');
		expect(webSearchTool.definition.function.parameters).toMatchObject({
			type: 'object',
			properties: {
				query: { type: 'string' },
				max_results: { type: 'integer', minimum: 1, maximum: 10 },
			},
			required: ['query'],
			additionalProperties: false,
		});
	});
});

describe('web_search isAvailable()', () => {
	it('returns false when [search] is absent', () => {
		loadSearchConfigMock.mockReturnValue(null);
		expect(webSearchTool.isAvailable?.()).toBe(false);
	});

	it('returns true when [search] is configured', () => {
		loadSearchConfigMock.mockReturnValue({
			url: 'http://searx.example.com',
			apiKey: null,
			timeoutSeconds: 10,
		});
		expect(webSearchTool.isAvailable?.()).toBe(true);
	});

	it('memoizes the config — only one loader call across availability + execute', async () => {
		loadSearchConfigMock.mockReturnValue({
			url: 'http://searx.example.com',
			apiKey: null,
			timeoutSeconds: 10,
		});
		globalThis.fetch = vi.fn(
			async () =>
				new Response(JSON.stringify({ results: [] }), {
					status: 200,
					headers: { 'content-type': 'application/json' },
				}),
		) as any;
		expect(webSearchTool.isAvailable?.()).toBe(true);
		await webSearchTool.execute({ query: 'x' }, ctx());
		expect(loadSearchConfigMock).toHaveBeenCalledTimes(1);
	});
});

describe('web_search args validation', () => {
	beforeEach(() => {
		loadSearchConfigMock.mockReturnValue({
			url: 'http://searx.example.com',
			apiKey: null,
			timeoutSeconds: 10,
		});
	});

	it('rejects missing query', async () => {
		const r = await webSearchTool.execute({}, ctx());
		expect(r.isError).toBe(true);
		expect(JSON.parse(r.content).error).toMatch(/query/i);
	});

	it('rejects non-string query', async () => {
		const r = await webSearchTool.execute({ query: 42 }, ctx());
		expect(r.isError).toBe(true);
	});

	it('rejects empty-string query', async () => {
		const r = await webSearchTool.execute({ query: '' }, ctx());
		expect(r.isError).toBe(true);
	});

	it('rejects non-numeric max_results', async () => {
		const r = await webSearchTool.execute({ query: 'x', max_results: 'lots' }, ctx());
		expect(r.isError).toBe(true);
	});

	it('returns the error when config is missing', async () => {
		loadSearchConfigMock.mockReturnValue(null);
		_resetConfigCacheForTests();
		const r = await webSearchTool.execute({ query: 'x' }, ctx());
		expect(r.isError).toBe(true);
		expect(JSON.parse(r.content).error).toMatch(/not configured/i);
	});
});

describe('web_search execute - successful path', () => {
	beforeEach(() => {
		loadSearchConfigMock.mockReturnValue({
			url: 'http://searx.example.com',
			apiKey: null,
			timeoutSeconds: 10,
		});
	});

	it('hits /search with the expected query params and returns terse results', async () => {
		let capturedUrl: URL | undefined;
		let capturedInit: RequestInit | undefined;
		globalThis.fetch = vi.fn(async (input: any, init: any) => {
			capturedUrl = input instanceof URL ? input : new URL(String(input));
			capturedInit = init;
			return new Response(
				JSON.stringify({
					results: [
						{ title: 'Result A', url: 'https://a.example/', content: 'snippet a' },
						{ title: 'Result B', url: 'https://b.example/', content: 'snippet b' },
						{ title: 'Result C', url: 'https://c.example/', content: 'snippet c' },
					],
				}),
				{ status: 200, headers: { 'content-type': 'application/json' } },
			);
		}) as any;

		const r = await webSearchTool.execute({ query: 'how to bake bread', max_results: 2 }, ctx());
		expect(r.isError).toBeUndefined();
		const parsed = JSON.parse(r.content);
		expect(parsed.query).toBe('how to bake bread');
		expect(parsed.results).toEqual([
			{ title: 'Result A', url: 'https://a.example/', snippet: 'snippet a' },
			{ title: 'Result B', url: 'https://b.example/', snippet: 'snippet b' },
		]);

		expect(capturedUrl?.pathname).toBe('/search');
		expect(capturedUrl?.searchParams.get('q')).toBe('how to bake bread');
		expect(capturedUrl?.searchParams.get('format')).toBe('json');
		expect(capturedUrl?.searchParams.get('safesearch')).toBe('1');

		const headers = capturedInit?.headers as Record<string, string>;
		expect(headers['user-agent']).toBe('glyphstream');
		expect(headers.authorization).toBeUndefined();
	});

	it('defaults max_results to 5 when omitted', async () => {
		const many = Array.from({ length: 10 }, (_, i) => ({
			title: `t${i}`,
			url: `https://e/${i}`,
			content: `c${i}`,
		}));
		globalThis.fetch = vi.fn(
			async () =>
				new Response(JSON.stringify({ results: many }), {
					status: 200,
					headers: { 'content-type': 'application/json' },
				}),
		) as any;
		const r = await webSearchTool.execute({ query: 'x' }, ctx());
		expect(JSON.parse(r.content).results).toHaveLength(5);
	});

	it('clamps max_results above 10 to 10', async () => {
		const many = Array.from({ length: 20 }, (_, i) => ({
			title: `t${i}`,
			url: `https://e/${i}`,
			content: `c${i}`,
		}));
		globalThis.fetch = vi.fn(
			async () =>
				new Response(JSON.stringify({ results: many }), {
					status: 200,
					headers: { 'content-type': 'application/json' },
				}),
		) as any;
		const r = await webSearchTool.execute({ query: 'x', max_results: 99 }, ctx());
		expect(JSON.parse(r.content).results).toHaveLength(10);
	});

	it('clamps max_results below 1 to 1', async () => {
		globalThis.fetch = vi.fn(
			async () =>
				new Response(
					JSON.stringify({ results: [{ title: 't', url: 'https://e/', content: 'c' }] }),
					{ status: 200, headers: { 'content-type': 'application/json' } },
				),
		) as any;
		const r = await webSearchTool.execute({ query: 'x', max_results: -3 }, ctx());
		expect(JSON.parse(r.content).results).toHaveLength(1);
	});

	it('tolerates missing fields in SearxNG result rows', async () => {
		globalThis.fetch = vi.fn(
			async () =>
				new Response(
					JSON.stringify({
						results: [
							{ url: 'https://only-url/' }, // no title, no content
							{ title: 't', content: 'c' }, // no url
						],
					}),
					{ status: 200, headers: { 'content-type': 'application/json' } },
				),
		) as any;
		const r = await webSearchTool.execute({ query: 'x' }, ctx());
		expect(r.isError).toBeUndefined();
		expect(JSON.parse(r.content).results).toEqual([
			{ title: '', url: 'https://only-url/', snippet: '' },
			{ title: 't', url: '', snippet: 'c' },
		]);
	});

	it('returns empty results when SearxNG returns no results array', async () => {
		globalThis.fetch = vi.fn(
			async () =>
				new Response('{}', {
					status: 200,
					headers: { 'content-type': 'application/json' },
				}),
		) as any;
		const r = await webSearchTool.execute({ query: 'x' }, ctx());
		expect(r.isError).toBeUndefined();
		expect(JSON.parse(r.content).results).toEqual([]);
	});
});

describe('web_search execute - auth + errors', () => {
	it('sends Authorization: Bearer when apiKey is configured', async () => {
		loadSearchConfigMock.mockReturnValue({
			url: 'http://searx.example.com',
			apiKey: 'super-secret',
			timeoutSeconds: 10,
		});
		let capturedInit: RequestInit | undefined;
		globalThis.fetch = vi.fn(async (_input: any, init: any) => {
			capturedInit = init;
			return new Response(JSON.stringify({ results: [] }), {
				status: 200,
				headers: { 'content-type': 'application/json' },
			});
		}) as any;
		await webSearchTool.execute({ query: 'x' }, ctx());
		const headers = capturedInit?.headers as Record<string, string>;
		expect(headers.authorization).toBe('Bearer super-secret');
	});

	it('returns isError on HTTP 500', async () => {
		loadSearchConfigMock.mockReturnValue({
			url: 'http://searx.example.com',
			apiKey: null,
			timeoutSeconds: 10,
		});
		globalThis.fetch = vi.fn(async () => new Response('', { status: 500 })) as any;
		const r = await webSearchTool.execute({ query: 'x' }, ctx());
		expect(r.isError).toBe(true);
		expect(JSON.parse(r.content).error).toMatch(/500/);
	});

	it('returns isError when response is not JSON', async () => {
		loadSearchConfigMock.mockReturnValue({
			url: 'http://searx.example.com',
			apiKey: null,
			timeoutSeconds: 10,
		});
		globalThis.fetch = vi.fn(
			async () =>
				new Response('<html>nope</html>', {
					status: 200,
					headers: { 'content-type': 'text/html' },
				}),
		) as any;
		const r = await webSearchTool.execute({ query: 'x' }, ctx());
		expect(r.isError).toBe(true);
		expect(JSON.parse(r.content).error).toMatch(/not valid JSON/);
	});

	it('returns isError on fetch failure (network)', async () => {
		loadSearchConfigMock.mockReturnValue({
			url: 'http://searx.example.com',
			apiKey: null,
			timeoutSeconds: 10,
		});
		globalThis.fetch = vi.fn(async () => {
			throw new TypeError('ECONNREFUSED');
		}) as any;
		const r = await webSearchTool.execute({ query: 'x' }, ctx());
		expect(r.isError).toBe(true);
		expect(JSON.parse(r.content).error).toMatch(/ECONNREFUSED/);
	});

	it('returns isError when caller signal is already aborted', async () => {
		loadSearchConfigMock.mockReturnValue({
			url: 'http://searx.example.com',
			apiKey: null,
			timeoutSeconds: 10,
		});
		const ac = new AbortController();
		ac.abort();
		globalThis.fetch = vi.fn(async (_url: any, init: any) => {
			if (init?.signal?.aborted) {
				throw new DOMException('aborted', 'AbortError');
			}
			return new Response('{}', { status: 200 });
		}) as any;
		const r = await webSearchTool.execute({ query: 'x' }, { ...ctx(), signal: ac.signal });
		expect(r.isError).toBe(true);
	});
});

function jsonResponse(body: unknown): Response {
	return new Response(JSON.stringify(body), {
		status: 200,
		headers: { 'content-type': 'application/json' },
	});
}

describe('web_search definition — freshness/category params', () => {
	it('advertises time_range as an enum plus categories and language', () => {
		const props = (webSearchTool.definition.function.parameters as any).properties;
		expect(props.time_range).toMatchObject({
			type: 'string',
			enum: ['day', 'week', 'month', 'year'],
		});
		expect(props.categories).toMatchObject({ type: 'string' });
		expect(props.language).toMatchObject({ type: 'string' });
	});
});

describe('web_search execute — freshness/category controls (B)', () => {
	beforeEach(() => {
		loadSearchConfigMock.mockReturnValue({
			url: 'http://searx.example.com',
			apiKey: null,
			timeoutSeconds: 10,
		});
	});

	it('forwards time_range, categories, and language as query params when given', async () => {
		let captured: URL | undefined;
		globalThis.fetch = vi.fn(async (input: any) => {
			captured = input instanceof URL ? input : new URL(String(input));
			return jsonResponse({ results: [] });
		}) as any;
		await webSearchTool.execute(
			{ query: 'x', time_range: 'week', categories: 'news,science', language: 'en-US' },
			ctx(),
		);
		expect(captured?.searchParams.get('time_range')).toBe('week');
		expect(captured?.searchParams.get('categories')).toBe('news,science');
		expect(captured?.searchParams.get('language')).toBe('en-US');
	});

	it('omits the optional params entirely when not provided', async () => {
		let captured: URL | undefined;
		globalThis.fetch = vi.fn(async (input: any) => {
			captured = input instanceof URL ? input : new URL(String(input));
			return jsonResponse({ results: [] });
		}) as any;
		await webSearchTool.execute({ query: 'x' }, ctx());
		expect(captured?.searchParams.has('time_range')).toBe(false);
		expect(captured?.searchParams.has('categories')).toBe(false);
		expect(captured?.searchParams.has('language')).toBe(false);
	});

	it('rejects an invalid time_range', async () => {
		globalThis.fetch = vi.fn(async () => jsonResponse({ results: [] })) as any;
		const r = await webSearchTool.execute({ query: 'x', time_range: 'fortnight' }, ctx());
		expect(r.isError).toBe(true);
		expect(JSON.parse(r.content).error).toMatch(/time_range/);
	});

	it('treats a blank categories/language as absent (no param set)', async () => {
		let captured: URL | undefined;
		globalThis.fetch = vi.fn(async (input: any) => {
			captured = input instanceof URL ? input : new URL(String(input));
			return jsonResponse({ results: [] });
		}) as any;
		await webSearchTool.execute({ query: 'x', categories: '   ', language: '' }, ctx());
		expect(captured?.searchParams.has('categories')).toBe(false);
		expect(captured?.searchParams.has('language')).toBe(false);
	});

	it('rejects a non-string categories', async () => {
		globalThis.fetch = vi.fn(async () => jsonResponse({ results: [] })) as any;
		const r = await webSearchTool.execute({ query: 'x', categories: 42 }, ctx());
		expect(r.isError).toBe(true);
		expect(JSON.parse(r.content).error).toMatch(/categories/);
	});
});

describe('web_search execute — answers / infoboxes / corrections (A)', () => {
	beforeEach(() => {
		loadSearchConfigMock.mockReturnValue({
			url: 'http://searx.example.com',
			apiKey: null,
			timeoutSeconds: 10,
		});
	});

	it('surfaces answers (object + string shapes), infoboxes, and corrections', async () => {
		globalThis.fetch = vi.fn(async () =>
			jsonResponse({
				results: [{ title: 't', url: 'https://e/', content: 'c' }],
				answers: [
					{ answer: '42', url: 'https://ans/' },
					'plain string answer',
					{ answer: '   ' }, // blank → dropped
				],
				infoboxes: [
					{
						infobox: 'Quokka',
						content: 'A small marsupial.',
						id: 'https://wikidata/Q123',
						attributes: [{ label: 'noise', value: 'dropped' }],
						urls: [{ title: 'x', url: 'y' }],
					},
				],
				corrections: ['quokka', '  ', 42],
			}),
		) as any;
		const parsed = JSON.parse((await webSearchTool.execute({ query: 'quoka' }, ctx())).content);
		expect(parsed.answers).toEqual([
			{ answer: '42', url: 'https://ans/' },
			{ answer: 'plain string answer' },
		]);
		expect(parsed.infoboxes).toEqual([
			{ title: 'Quokka', content: 'A small marsupial.', url: 'https://wikidata/Q123' },
		]);
		expect(parsed.corrections).toEqual(['quokka']);
	});

	it('omits the blocks entirely when SearxNG returns none', async () => {
		globalThis.fetch = vi.fn(async () =>
			jsonResponse({ results: [{ title: 't', url: 'https://e/', content: 'c' }] }),
		) as any;
		const parsed = JSON.parse((await webSearchTool.execute({ query: 'x' }, ctx())).content);
		expect(parsed).not.toHaveProperty('answers');
		expect(parsed).not.toHaveProperty('infoboxes');
		expect(parsed).not.toHaveProperty('corrections');
	});

	it('tolerates malformed answer/infobox entries', async () => {
		globalThis.fetch = vi.fn(async () =>
			jsonResponse({
				results: [],
				answers: [null, 123, { noanswer: true }],
				infoboxes: [null, 'nope', { id: 'https://x/' }], // no title/content → dropped
			}),
		) as any;
		const parsed = JSON.parse((await webSearchTool.execute({ query: 'x' }, ctx())).content);
		expect(parsed).not.toHaveProperty('answers');
		expect(parsed).not.toHaveProperty('infoboxes');
	});
});

describe('web_search execute — near-duplicate dedupe (C)', () => {
	beforeEach(() => {
		loadSearchConfigMock.mockReturnValue({
			url: 'http://searx.example.com',
			apiKey: null,
			timeoutSeconds: 10,
		});
	});

	it('collapses www / trailing-slash / tracking-param mirrors, keeping the first', async () => {
		globalThis.fetch = vi.fn(async () =>
			jsonResponse({
				results: [
					{ title: 'Canonical', url: 'https://example.com/post', content: 'first' },
					{ title: 'Mirror www', url: 'https://www.example.com/post/', content: 'dupe' },
					{
						title: 'Mirror utm',
						url: 'https://example.com/post?utm_source=twitter',
						content: 'dupe',
					},
					{ title: 'Distinct', url: 'https://example.com/other', content: 'keep' },
				],
			}),
		) as any;
		const parsed = JSON.parse((await webSearchTool.execute({ query: 'x' }, ctx())).content);
		expect(parsed.results.map((r: any) => r.title)).toEqual(['Canonical', 'Distinct']);
	});

	it('does NOT merge genuinely distinct pages that differ by a content query param', async () => {
		globalThis.fetch = vi.fn(async () =>
			jsonResponse({
				results: [
					{ title: 'Item 1', url: 'https://shop.example/item?id=1', content: 'a' },
					{ title: 'Item 2', url: 'https://shop.example/item?id=2', content: 'b' },
				],
			}),
		) as any;
		const parsed = JSON.parse((await webSearchTool.execute({ query: 'x' }, ctx())).content);
		expect(parsed.results).toHaveLength(2);
	});

	it('applies max_results AFTER dedupe, so the count is distinct hits', async () => {
		globalThis.fetch = vi.fn(async () =>
			jsonResponse({
				results: [
					{ title: 'A', url: 'https://a.example/', content: '1' },
					{ title: 'A-mirror', url: 'https://www.a.example', content: '1' },
					{ title: 'B', url: 'https://b.example/', content: '2' },
					{ title: 'C', url: 'https://c.example/', content: '3' },
				],
			}),
		) as any;
		const parsed = JSON.parse(
			(await webSearchTool.execute({ query: 'x', max_results: 2 }, ctx())).content,
		);
		// Without dedupe-before-slice this would be [A, A-mirror]; with it, [A, B].
		expect(parsed.results.map((r: any) => r.title)).toEqual(['A', 'B']);
	});

	it('keeps multiple url-less rows rather than collapsing them', async () => {
		globalThis.fetch = vi.fn(async () =>
			jsonResponse({
				results: [
					{ title: 'no url one', content: 'a' },
					{ title: 'no url two', content: 'b' },
				],
			}),
		) as any;
		const parsed = JSON.parse((await webSearchTool.execute({ query: 'x' }, ctx())).content);
		expect(parsed.results).toHaveLength(2);
	});
});
