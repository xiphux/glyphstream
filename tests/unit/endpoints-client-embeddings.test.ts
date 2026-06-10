import { afterEach, describe, expect, it, vi } from 'vitest';
import { embeddings, UpstreamError } from '$lib/server/endpoints/client';
import type { LoadedEndpoint } from '$lib/server/endpoints/config';

const realFetch = globalThis.fetch;
afterEach(() => {
	globalThis.fetch = realFetch;
});

function endpoint(overrides: Partial<LoadedEndpoint> = {}): LoadedEndpoint {
	return {
		id: 'embed',
		displayName: 'Embed',
		baseUrl: 'http://embed.local/v1',
		apiKey: null,
		requestTimeoutSeconds: 30,
		providerQuirk: 'passthrough',
		groupBy: 'endpoint',
		supportsTools: false,
		maxConcurrent: 4,
		...overrides,
	} as LoadedEndpoint;
}

describe('embeddings()', () => {
	it('POSTs batched input to {baseUrl}/embeddings and parses data[].embedding', async () => {
		const fetchMock = vi.fn(
			async () =>
				new Response(
					JSON.stringify({
						data: [
							{ index: 0, embedding: [0.1, 0.2] },
							{ index: 1, embedding: [0.3, 0.4] },
						],
					}),
					{ status: 200, headers: { 'content-type': 'application/json' } },
				),
		);
		globalThis.fetch = fetchMock as never;

		const res = await embeddings(endpoint(), { model: 'm', input: ['a', 'b'] });

		const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
		expect(url).toBe('http://embed.local/v1/embeddings');
		expect(init.method).toBe('POST');
		expect(JSON.parse(init.body as string)).toEqual({ model: 'm', input: ['a', 'b'] });
		expect(res.data?.map((d) => d.embedding)).toEqual([
			[0.1, 0.2],
			[0.3, 0.4],
		]);
	});

	it('sends an Authorization header when the endpoint has an apiKey', async () => {
		const fetchMock = vi.fn(
			async () =>
				new Response(JSON.stringify({ data: [] }), {
					status: 200,
					headers: { 'content-type': 'application/json' },
				}),
		);
		globalThis.fetch = fetchMock as never;
		await embeddings(endpoint({ apiKey: 'secret' }), { model: 'm', input: ['x'] });
		const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
		const headers = init.headers as Record<string, string>;
		expect(headers.Authorization).toBe('Bearer secret');
	});

	it('wraps an HTTP error as UpstreamError carrying the status', async () => {
		globalThis.fetch = vi.fn(async () => new Response('nope', { status: 500 })) as never;
		await expect(embeddings(endpoint(), { model: 'm', input: ['x'] })).rejects.toMatchObject({
			status: 500,
		});
	});

	it('wraps a network failure as UpstreamError', async () => {
		globalThis.fetch = vi.fn(async () => {
			throw new Error('ECONNREFUSED');
		}) as never;
		await expect(embeddings(endpoint(), { model: 'm', input: ['x'] })).rejects.toBeInstanceOf(
			UpstreamError,
		);
	});
});
