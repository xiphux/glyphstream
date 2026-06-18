import { afterEach, describe, expect, it, vi } from 'vitest';
import { normalizeRerankResponse, rerank, UpstreamError } from '$lib/server/endpoints/client';
import type { LoadedEndpoint } from '$lib/server/endpoints/config';

const realFetch = globalThis.fetch;
afterEach(() => {
	globalThis.fetch = realFetch;
});

function endpoint(overrides: Partial<LoadedEndpoint> = {}): LoadedEndpoint {
	return {
		id: 'rr',
		displayName: 'Rerank',
		baseUrl: 'http://rr.local/v1',
		apiKey: null,
		requestTimeoutSeconds: 30,
		providerQuirk: 'passthrough',
		groupBy: 'endpoint',
		supportsTools: false,
		maxConcurrent: 4,
		...overrides,
	} as LoadedEndpoint;
}

function jsonResponse(body: unknown): Response {
	return new Response(JSON.stringify(body), {
		status: 200,
		headers: { 'content-type': 'application/json' },
	});
}

describe('rerank()', () => {
	it('Cohere/Jina shape: POSTs {documents, top_n} to {baseUrl}/rerank and reads results[].relevance_score', async () => {
		const fetchMock = vi.fn(async () =>
			jsonResponse({
				results: [
					{ index: 1, relevance_score: 0.9 },
					{ index: 0, relevance_score: 0.2 },
				],
			}),
		);
		globalThis.fetch = fetchMock as never;

		const out = await rerank(
			endpoint(),
			{ model: 'bge', query: 'q', documents: ['a', 'b'], topN: 2 },
			undefined,
		);

		const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
		expect(url).toBe('http://rr.local/v1/rerank');
		expect(init.method).toBe('POST');
		expect(JSON.parse(init.body as string)).toEqual({
			model: 'bge',
			query: 'q',
			documents: ['a', 'b'],
			top_n: 2,
		});
		expect(out).toEqual([
			{ index: 1, score: 0.9 },
			{ index: 0, score: 0.2 },
		]);
	});

	it('TEI quirk: strips /v1, sends {texts}, and reads a bare [{index, score}] array', async () => {
		const fetchMock = vi.fn(async () =>
			jsonResponse([
				{ index: 0, score: 0.7 },
				{ index: 1, score: 0.3 },
			]),
		);
		globalThis.fetch = fetchMock as never;

		const out = await rerank(
			endpoint(),
			{ model: 'bge', query: 'q', documents: ['a', 'b'], topN: 2 },
			'tei',
		);

		const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
		expect(url).toBe('http://rr.local/rerank');
		expect(JSON.parse(init.body as string)).toEqual({ query: 'q', texts: ['a', 'b'] });
		expect(out).toEqual([
			{ index: 0, score: 0.7 },
			{ index: 1, score: 0.3 },
		]);
	});

	it('drops rows missing a numeric index or score', async () => {
		globalThis.fetch = vi.fn(async () =>
			jsonResponse({
				results: [
					{ index: 0, relevance_score: 0.5 },
					{ relevance_score: 0.9 }, // no index
					{ index: 2 }, // no score
				],
			}),
		) as never;
		const out = await rerank(
			endpoint(),
			{ model: 'm', query: 'q', documents: ['a', 'b', 'c'], topN: 3 },
			undefined,
		);
		expect(out).toEqual([{ index: 0, score: 0.5 }]);
	});

	it('drops a row whose score is present-but-null over the wire', async () => {
		globalThis.fetch = vi.fn(async () =>
			jsonResponse({
				results: [
					{ index: 0, relevance_score: 0.5 },
					{ index: 1, relevance_score: null }, // null → not a number, dropped
				],
			}),
		) as never;
		const out = await rerank(
			endpoint(),
			{ model: 'm', query: 'q', documents: ['a', 'b'], topN: 2 },
			undefined,
		);
		expect(out).toEqual([{ index: 0, score: 0.5 }]);
	});

	it('sends an Authorization header when the endpoint has an apiKey', async () => {
		const fetchMock = vi.fn(async () => jsonResponse({ results: [] }));
		globalThis.fetch = fetchMock as never;
		await rerank(
			endpoint({ apiKey: 'secret' }),
			{ model: 'm', query: 'q', documents: ['x'], topN: 1 },
			undefined,
		);
		const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
		expect((init.headers as Record<string, string>).Authorization).toBe('Bearer secret');
	});

	it('wraps an HTTP error as UpstreamError carrying the status', async () => {
		globalThis.fetch = vi.fn(async () => new Response('nope', { status: 503 })) as never;
		await expect(
			rerank(endpoint(), { model: 'm', query: 'q', documents: ['x'], topN: 1 }, undefined),
		).rejects.toMatchObject({ status: 503 });
	});

	it('wraps a network failure as UpstreamError', async () => {
		globalThis.fetch = vi.fn(async () => {
			throw new Error('ECONNREFUSED');
		}) as never;
		await expect(
			rerank(endpoint(), { model: 'm', query: 'q', documents: ['x'], topN: 1 }, undefined),
		).rejects.toBeInstanceOf(UpstreamError);
	});
});

describe('normalizeRerankResponse', () => {
	// JSON.parse can't produce NaN/Infinity, so these only reach the normalizer
	// via a hypothetical non-JSON path — but the guard keeps a non-finite score
	// out of the downstream sort regardless of how it arrived.
	it('drops rows with a non-finite score (NaN / Infinity)', () => {
		const out = normalizeRerankResponse({
			results: [
				{ index: 0, relevance_score: 0.4 },
				{ index: 1, relevance_score: NaN },
				{ index: 2, relevance_score: Infinity },
				{ index: 3, relevance_score: -Infinity },
			],
		});
		expect(out).toEqual([{ index: 0, score: 0.4 }]);
	});

	it('drops rows with a non-finite index', () => {
		const out = normalizeRerankResponse([
			{ index: NaN, score: 0.9 },
			{ index: 1, score: 0.3 },
		]);
		expect(out).toEqual([{ index: 1, score: 0.3 }]);
	});
});
