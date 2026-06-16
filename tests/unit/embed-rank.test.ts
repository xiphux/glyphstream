import { describe, expect, it, vi } from 'vitest';

// embed-rank.ts reaches the backend only through the embeddings client; mock it
// so we can observe batching without real I/O.
const embeddingsMock = vi.hoisted(() => vi.fn());
vi.mock('$lib/server/endpoints/client', () => ({ embeddings: embeddingsMock }));

import {
	embedAndRank,
	embedAndRankCached,
	type RelevanceConfig,
} from '$lib/server/retrieval/embed-rank';
import type { Vec } from '$lib/server/retrieval/vector';

const fakeEndpoint = { id: 'e', baseUrl: 'http://e', apiKey: null } as never;
function cfg(): RelevanceConfig {
	return {
		endpoint: fakeEndpoint,
		modelId: 'm',
		timeoutSeconds: 5,
		embedCap: 1000,
		queryPrefix: '',
		documentPrefix: '',
		maxInputTokens: 512,
	};
}
const signal = new AbortController().signal;

// Reset INSIDE each test, not in a beforeEach hook: vitest 4 mishandles a
// beforeEach reset of this async embeddings mock (surfaces a spurious trailing
// invocation). The bounded-concurrency assertion lives in
// embed-rank-concurrency.test.ts.

describe('embedAndRank', () => {
	it('ranks docs by cosine and returns indices relative to docs', async () => {
		embeddingsMock.mockReset();
		embeddingsMock.mockImplementation(async (_ep: unknown, body: { input: string[] }) => ({
			data: body.input.map((s, index) => ({
				index,
				embedding: s.includes('cat') ? [1, 0] : [0, 1],
			})),
		}));
		const out = await embedAndRank('cat', ['a dog', 'a cat'], cfg(), signal);
		expect(out).not.toBeNull();
		expect(out![0].index).toBe(1); // 'a cat' is the closer doc
	});

	it('returns null (BM25 fallback) when a batch fails', async () => {
		embeddingsMock.mockReset();
		embeddingsMock.mockRejectedValue(new Error('endpoint down'));
		expect(await embedAndRank('q', ['a', 'b'], cfg(), signal)).toBeNull();
	});
});

describe('embedAndRankCached', () => {
	it('embeds each doc once across calls, re-embedding only the query', async () => {
		embeddingsMock.mockReset();
		embeddingsMock.mockImplementation(async (_ep: unknown, body: { input: string[] }) => ({
			data: body.input.map((s, index) => ({
				index,
				embedding: s.includes('cat') ? [1, 0] : [0, 1],
			})),
		}));
		const cache = new Map<string, Vec>();
		const docs = ['a cat doc', 'a dog doc'];

		const first = await embedAndRankCached('cat', docs, cfg(), signal, cache);
		expect(first).not.toBeNull();
		expect(embeddingsMock.mock.calls.flatMap((c) => c[1].input)).toHaveLength(1 + 2);

		embeddingsMock.mockClear();
		const second = await embedAndRankCached('cat again', docs, cfg(), signal, cache);
		expect(second).not.toBeNull();
		// Docs cached → only the new query is sent.
		expect(embeddingsMock.mock.calls.flatMap((c) => c[1].input)).toEqual(['cat again']);
		// The cat doc still ranks first off the cached vectors.
		expect(second![0].index).toBe(0);
	});

	it('embeds only the uncached docs when the catalog grows', async () => {
		embeddingsMock.mockReset();
		embeddingsMock.mockImplementation(async (_ep: unknown, body: { input: string[] }) => ({
			data: body.input.map((_s, index) => ({ index, embedding: [1, 0] })),
		}));
		const cache = new Map<string, Vec>();
		await embedAndRankCached('q', ['one'], cfg(), signal, cache);

		embeddingsMock.mockClear();
		await embedAndRankCached('q', ['one', 'two'], cfg(), signal, cache);
		// 'one' is cached; only the query + 'two' are sent.
		expect(embeddingsMock.mock.calls.flatMap((c) => c[1].input)).toEqual(['q', 'two']);
	});

	it('returns null (BM25 fallback) when the embedding call fails', async () => {
		embeddingsMock.mockReset();
		embeddingsMock.mockRejectedValue(new Error('endpoint down'));
		expect(await embedAndRankCached('q', ['a'], cfg(), signal, new Map())).toBeNull();
	});
});
