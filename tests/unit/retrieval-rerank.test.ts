import { beforeEach, describe, expect, it, vi } from 'vitest';

const rerankClientMock = vi.hoisted(() => vi.fn());
vi.mock('$lib/server/endpoints/client', () => ({ rerank: rerankClientMock }));

import { rerankDocs, type RerankConfig } from '$lib/server/retrieval/rerank';

const cfg: RerankConfig = {
	endpoint: { id: 'e', baseUrl: 'http://e', apiKey: null } as never,
	modelId: 'bge',
	timeoutSeconds: 5,
	topN: 20,
	quirk: undefined,
};
const signal = new AbortController().signal;

beforeEach(() => rerankClientMock.mockReset());

describe('rerankDocs', () => {
	it('returns candidate indices ordered by descending reranker score', async () => {
		rerankClientMock.mockResolvedValue([
			{ index: 0, score: 0.1 },
			{ index: 2, score: 0.9 },
			{ index: 1, score: 0.5 },
		]);
		const out = await rerankDocs('q', ['a', 'b', 'c'], cfg, signal);
		expect(out).toEqual([
			{ index: 2, score: 0.9 },
			{ index: 1, score: 0.5 },
			{ index: 0, score: 0.1 },
		]);
	});

	it('forwards the query, documents, and quirk to the client', async () => {
		rerankClientMock.mockResolvedValue([{ index: 0, score: 1 }]);
		await rerankDocs('find me', ['x', 'y'], { ...cfg, quirk: 'tei' }, signal);
		const [ep, body, quirk] = rerankClientMock.mock.calls[0] as unknown as [
			unknown,
			{ model: string; query: string; documents: string[]; topN: number },
			string,
		];
		expect(ep).toBe(cfg.endpoint);
		expect(body).toEqual({ model: 'bge', query: 'find me', documents: ['x', 'y'], topN: 2 });
		expect(quirk).toBe('tei');
	});

	it('drops out-of-range indices a misbehaving backend might return', async () => {
		rerankClientMock.mockResolvedValue([
			{ index: 5, score: 0.9 }, // out of range for 2 docs
			{ index: 1, score: 0.4 },
		]);
		const out = await rerankDocs('q', ['a', 'b'], cfg, signal);
		expect(out).toEqual([{ index: 1, score: 0.4 }]);
	});

	it('dedupes a repeated index, keeping the first (highest-scored) occurrence', async () => {
		rerankClientMock.mockResolvedValue([
			{ index: 0, score: 0.9 },
			{ index: 0, score: 0.8 },
			{ index: 1, score: 0.5 },
		]);
		const out = await rerankDocs('q', ['a', 'b'], cfg, signal);
		expect(out).toEqual([
			{ index: 0, score: 0.9 },
			{ index: 1, score: 0.5 },
		]);
	});

	it('returns null on an empty document list without calling the client', async () => {
		const out = await rerankDocs('q', [], cfg, signal);
		expect(out).toBeNull();
		expect(rerankClientMock).not.toHaveBeenCalled();
	});

	it('returns null when the reranker yields no usable rows', async () => {
		rerankClientMock.mockResolvedValue([]);
		expect(await rerankDocs('q', ['a', 'b'], cfg, signal)).toBeNull();
	});

	// The client-throws → null degradation path is exercised here too, but as its
	// own file: vitest v4 surfaces a thrown mock result as a test error when a
	// *fulfilled* result precedes it on the same spy (the resolved-value cases
	// above), and per-test mockReset doesn't clear that tracking. Isolating it
	// keeps the spy free of a prior fulfilled result. (The same catch is also
	// covered end-to-end by retrieval-select.test.ts's "reranker fails" case.)
});
