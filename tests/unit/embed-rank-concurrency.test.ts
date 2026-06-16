import { describe, expect, it, vi } from 'vitest';

// Isolated in its own file on purpose: this test drives the embeddings mock with
// many genuinely-concurrent async invocations (real setTimeout), and vitest 4
// surfaces a spurious trailing mock invocation when such a mock is reset between
// runs in the same file. One test, no beforeEach, no cross-test reset → clean.
const embeddingsMock = vi.hoisted(() => vi.fn());
vi.mock('$lib/server/endpoints/client', () => ({ embeddings: embeddingsMock }));

import { embedAndRank, type RelevanceConfig } from '$lib/server/retrieval/embed-rank';

const fakeEndpoint = { id: 'e', baseUrl: 'http://e', apiKey: null } as never;
const cfg: RelevanceConfig = {
	endpoint: fakeEndpoint,
	modelId: 'm',
	timeoutSeconds: 5,
	queryPrefix: '',
	documentPrefix: '',
	maxInputTokens: 512,
};
const signal = new AbortController().signal;

describe('embedAndRank — bounded batch concurrency', () => {
	it('caps simultaneous embedding requests at 3 across many batches', async () => {
		let inFlight = 0;
		let peak = 0;
		embeddingsMock.mockImplementation(async (_ep: unknown, body: { input: string[] }) => {
			inFlight++;
			peak = Math.max(peak, inFlight);
			await new Promise((r) => setTimeout(r, 0));
			inFlight--;
			return { data: body.input.map((_s, index) => ({ index, embedding: [1, 0] })) };
		});
		// 40 docs + query = 41 inputs → 6 batches (≤8 items each). Without the cap
		// all 6 would run at once; with it, peak holds at the cap while still being
		// genuinely parallel (> 1).
		const docs = Array.from({ length: 40 }, (_, i) => `doc ${i}`);
		const out = await embedAndRank('q', docs, cfg, signal);
		expect(out).toHaveLength(40);
		expect(embeddingsMock.mock.calls.length).toBe(6);
		expect(peak).toBe(3);
	});
});
