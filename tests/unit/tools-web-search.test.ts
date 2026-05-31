import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock the config loader so we can control what `[search]` looks like.
const loadSearchConfigMock = vi.hoisted(() => vi.fn());
vi.mock('$lib/server/endpoints/config', () => ({
	loadSearchConfig: loadSearchConfigMock,
}));

import { webSearchTool, _resetConfigCacheForTests } from '$lib/server/tools/web-search';
import type { ToolContext } from '$lib/server/tools/types';

function ctx(): ToolContext {
	return { userId: 'u1', conversationId: 'c1', signal: new AbortController().signal };
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
