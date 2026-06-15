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

import { recallMemoryTool } from '$lib/server/tools/memory';
import { createMemory, setMemoryEmbedding } from '$lib/server/db/queries/memories';
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

const ctx = {
	userId: '',
	conversationId: 'c1',
	signal: new AbortController().signal,
	disabledFeatures: [],
};

/** Mock a query-embedding response (single input → single vector). */
function mockQueryVec(vec: number[]) {
	embeddingsMock.mockResolvedValue({ data: [{ index: 0, embedding: vec }] });
}

async function run(query: unknown) {
	const res = await recallMemoryTool.execute({ query }, ctx);
	return { res, parsed: res.isError ? null : JSON.parse(res.content) };
}

beforeEach(() => {
	mocks.testDb = createTestDb();
	embeddingsMock.mockReset();
	resolveMock.mockReset();
	resolveMock.mockReturnValue(CFG);
});

afterEach(() => closeTestDb());

describe('recallMemoryTool.isAvailable', () => {
	it('is true when an embedding model resolves', () => {
		resolveMock.mockReturnValue(CFG);
		expect(recallMemoryTool.isAvailable?.()).toBe(true);
	});

	it('is false when no embedding model is configured', () => {
		resolveMock.mockReturnValue(undefined);
		expect(recallMemoryTool.isAvailable?.()).toBe(false);
	});
});

describe('recallMemoryTool.execute', () => {
	it('returns an empty match list for a user with no memories', async () => {
		const u = seedUser();
		const { res, parsed } = await run('anything');
		void u;
		expect(res.isError).toBeFalsy();
		expect(parsed.matches).toEqual([]);
		// No memories → no point hitting the embedding endpoint.
		expect(embeddingsMock).not.toHaveBeenCalled();
	});

	it('ranks the semantically-closest memory first via the dense leg', async () => {
		const u = seedUser();
		ctx.userId = u.id;
		const a = createMemory(u.id, 'alpha note');
		const b = createMemory(u.id, 'beta note');
		setMemoryEmbedding(a.id, encodeVector([1, 0]), MODEL);
		setMemoryEmbedding(b.id, encodeVector([0, 1]), MODEL);
		// Query embeds near A's vector; lexically neutral so the dense leg drives.
		mockQueryVec([0.9, 0.1]);

		const { parsed } = await run('unrelated wording');
		expect(parsed.matches[0].id).toBe(a.id);
	});

	it('finds a not-yet-embedded memory via the BM25 leg', async () => {
		const u = seedUser();
		ctx.userId = u.id;
		createMemory(u.id, 'the quokka migration plan'); // no embedding stored
		mockQueryVec([1, 0]); // dense leg has nothing to compare → BM25 only

		const { parsed } = await run('quokka');
		expect(parsed.matches.map((m: { content: string }) => m.content)).toContain(
			'the quokka migration plan',
		);
	});

	it('degrades to BM25 (no error) when the embedding endpoint fails', async () => {
		const u = seedUser();
		ctx.userId = u.id;
		const a = createMemory(u.id, 'the quokka migration plan');
		setMemoryEmbedding(a.id, encodeVector([1, 0]), MODEL);
		embeddingsMock.mockRejectedValue(new Error('endpoint down'));

		const { res, parsed } = await run('quokka');
		expect(res.isError).toBeFalsy();
		expect(parsed.matches.map((m: { id: string }) => m.id)).toContain(a.id);
	});

	it('ignores rows embedded by a different model (incomparable vector space)', async () => {
		const u = seedUser();
		ctx.userId = u.id;
		const a = createMemory(u.id, 'stale model row');
		setMemoryEmbedding(a.id, encodeVector([1, 0, 0]), 'old-model'); // wrong dim + model
		mockQueryVec([1, 0]); // current-model query vec (dim 2)

		// Dense leg must skip the stale-model row rather than dimension-mismatch
		// throw; BM25 still returns it. The point: no crash, result still comes.
		const { res, parsed } = await run('stale');
		expect(res.isError).toBeFalsy();
		expect(parsed.matches.map((m: { id: string }) => m.id)).toContain(a.id);
	});

	it('returns a recoverable error for a missing query argument', async () => {
		const u = seedUser();
		ctx.userId = u.id;
		const res = await recallMemoryTool.execute({}, ctx);
		expect(res.isError).toBe(true);
	});
});
