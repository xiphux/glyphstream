import { describe, expect, it, vi } from 'vitest';

// Isolated from retrieval-rerank.test.ts on purpose: vitest v4 reports a thrown
// mock result as a test error when a *fulfilled* result precedes it on the same
// spy, and per-test mockReset doesn't clear that tracking. Here the rerank spy's
// only result is the throw, so the degradation contract — any client failure
// returns null rather than propagating — is verified cleanly.
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

describe('rerankDocs — client failure', () => {
	it('returns null (not throw) when the client errors', async () => {
		rerankClientMock.mockImplementation(() => {
			throw new Error('endpoint down');
		});
		expect(await rerankDocs('q', ['a', 'b'], cfg, signal)).toBeNull();
	});
});
