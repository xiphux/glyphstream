import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDb, closeTestDb, type TestDB } from './_helpers/test-db';
import { seedUser } from './_helpers/seed';

const mocks = vi.hoisted(() => ({ testDb: null as unknown as TestDB }));
vi.mock('$lib/server/db/client', () => ({
	getDb: () => mocks.testDb,
	closeDb: () => {},
}));

const embeddingsMock = vi.hoisted(() => vi.fn());
vi.mock('$lib/server/endpoints/client', () => ({ embeddings: embeddingsMock }));

const resolveMock = vi.hoisted(() => vi.fn());
vi.mock('$lib/server/retrieval/embeddings-config', () => ({
	resolveRelevanceConfig: resolveMock,
}));

import { runBackfillSweep } from '$lib/server/memory/embedding-backfill';
import {
	createMemory,
	listMemoriesNeedingEmbedding,
	listMemoriesWithEmbeddings,
	setMemoryEmbedding,
} from '$lib/server/db/queries/memories';
import { encodeVector } from '$lib/server/retrieval/vector';

const MODEL = 'embed-v1';
const CFG = {
	endpoint: { id: 'e', baseUrl: 'http://e', apiKey: null },
	modelId: MODEL,
	timeoutSeconds: 5,
	embedCap: 64,
	queryPrefix: '',
	documentPrefix: '',
	maxInputTokens: 512,
};

beforeEach(() => {
	mocks.testDb = createTestDb();
	embeddingsMock.mockReset();
	resolveMock.mockReset();
	resolveMock.mockReturnValue(CFG);
	// Echo one vector per input, in order.
	embeddingsMock.mockImplementation(async (_ep: unknown, body: { input: string[] }) => ({
		data: body.input.map((_s, index) => ({ index, embedding: [index + 1, 0] })),
	}));
});

afterEach(() => closeTestDb());

describe('runBackfillSweep', () => {
	it('is a no-op when no embedding model is configured', async () => {
		resolveMock.mockReturnValue(undefined);
		const u = seedUser();
		createMemory(u.id, 'fact');
		const { embedded } = await runBackfillSweep();
		expect(embedded).toBe(0);
		expect(embeddingsMock).not.toHaveBeenCalled();
	});

	it('embeds rows that have no vector yet, across users', async () => {
		const u1 = seedUser();
		const u2 = seedUser();
		createMemory(u1.id, 'u1 fact');
		createMemory(u2.id, 'u2 fact');

		const { embedded } = await runBackfillSweep();
		expect(embedded).toBe(2);
		expect(listMemoriesNeedingEmbedding(MODEL, 100)).toHaveLength(0);
		for (const row of [
			...listMemoriesWithEmbeddings(u1.id),
			...listMemoriesWithEmbeddings(u2.id),
		]) {
			expect(row.embedding).not.toBeNull();
			expect(row.embeddingModel).toBe(MODEL);
		}
	});

	it('re-embeds a row whose stored vector came from a different model', async () => {
		const u = seedUser();
		const { id } = createMemory(u.id, 'fact');
		setMemoryEmbedding(id, 'fact', encodeVector([9, 9]), 'old-model');

		const { embedded } = await runBackfillSweep();
		expect(embedded).toBe(1);
		expect(listMemoriesWithEmbeddings(u.id)[0].embeddingModel).toBe(MODEL);
	});

	it('does nothing when every row is already current', async () => {
		const u = seedUser();
		const { id } = createMemory(u.id, 'fact');
		setMemoryEmbedding(id, 'fact', encodeVector([1, 0]), MODEL);
		const { embedded } = await runBackfillSweep();
		expect(embedded).toBe(0);
		expect(embeddingsMock).not.toHaveBeenCalled();
	});

	it('leaves rows for the next sweep when the endpoint fails', async () => {
		const u = seedUser();
		createMemory(u.id, 'fact');
		embeddingsMock.mockRejectedValue(new Error('endpoint down'));
		const { embedded } = await runBackfillSweep();
		expect(embedded).toBe(0);
		expect(listMemoriesNeedingEmbedding(MODEL, 100)).toHaveLength(1);
	});

	it('writes the vectors that came back on a short response, not discarding the batch', async () => {
		const u = seedUser();
		createMemory(u.id, 'aaa');
		createMemory(u.id, 'bbb');
		createMemory(u.id, 'ccc');
		// Backend always omits 'bbb' from its response. The batch must not be
		// discarded for the count mismatch — 'aaa' and 'ccc' embed, 'bbb' re-queues
		// (and the next loop's 1-row batch comes back empty, ending the sweep).
		embeddingsMock.mockImplementation(async (_ep: unknown, body: { input: string[] }) => ({
			data: body.input
				.map((s, index) => ({ s, index }))
				.filter((x) => x.s !== 'bbb')
				.map((x) => ({ index: x.index, embedding: [1, 0] })),
		}));
		const { embedded } = await runBackfillSweep();
		expect(embedded).toBe(2);
		const stillQueued = listMemoriesNeedingEmbedding(MODEL, 100);
		expect(stillQueued).toHaveLength(1);
		expect(stillQueued[0].content).toBe('bbb');
	});
});
