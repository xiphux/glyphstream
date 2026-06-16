import { describe, expect, it, vi } from 'vitest';

// embed-rank.ts reaches the backend only through the embeddings client; mock it
// so we can observe batching without real I/O.
const embeddingsMock = vi.hoisted(() => vi.fn());
vi.mock('$lib/server/endpoints/client', () => ({ embeddings: embeddingsMock }));

import {
	embedAndRank,
	embedAndRankCached,
	embedQuery,
	inputCharCap,
	truncate,
	CHARS_PER_TOKEN,
	type RelevanceConfig,
} from '$lib/server/retrieval/embed-rank';
import type { Vec } from '$lib/server/retrieval/vector';

const fakeEndpoint = { id: 'e', baseUrl: 'http://e', apiKey: null } as never;
function cfg(): RelevanceConfig {
	return {
		endpoint: fakeEndpoint,
		modelId: 'm',
		timeoutSeconds: 5,
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

describe('inputCharCap / truncate (shared write-side ↔ read-side caps)', () => {
	it('derives the char cap from maxInputTokens × CHARS_PER_TOKEN, floored, min 1', () => {
		expect(inputCharCap(512)).toBe(Math.floor(512 * CHARS_PER_TOKEN));
		expect(inputCharCap(0)).toBe(1); // never zero — a 0-length cap would drop all input
	});

	it('truncates only when over the cap', () => {
		expect(truncate('abcdef', 3)).toBe('abc');
		expect(truncate('ab', 3)).toBe('ab');
	});
});

describe('embedQuery', () => {
	it('applies the query prefix + truncation and returns the single vector', async () => {
		embeddingsMock.mockReset();
		const seen: string[] = [];
		embeddingsMock.mockImplementation(async (_ep: unknown, body: { input: string[] }) => {
			seen.push(...body.input);
			return { data: [{ index: 0, embedding: [1, 2, 3] }] };
		});
		const c = { ...cfg(), queryPrefix: 'search_query: ', maxInputTokens: 1 };
		const vec = await embedQuery('a very long query string', c, signal);
		expect(vec).toEqual([1, 2, 3]);
		// prefix applied + truncated to inputCharCap(1) chars of the raw query.
		expect(seen).toEqual(['search_query: ' + 'a very long query string'.slice(0, inputCharCap(1))]);
	});

	it('returns null on a malformed/empty response (BM25 fallback)', async () => {
		embeddingsMock.mockReset();
		embeddingsMock.mockResolvedValue({ data: [{ index: 0, embedding: [] }] });
		expect(await embedQuery('q', cfg(), signal)).toBeNull();
	});

	it('returns null when the embedding call throws', async () => {
		embeddingsMock.mockReset();
		embeddingsMock.mockRejectedValue(new Error('endpoint down'));
		expect(await embedQuery('q', cfg(), signal)).toBeNull();
	});
});
