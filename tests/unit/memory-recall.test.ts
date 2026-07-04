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

async function runArgs(args: unknown) {
	const res = await recallMemoryTool.execute(args, ctx);
	return { res, parsed: res.isError ? null : JSON.parse(res.content) };
}

beforeEach(() => {
	mocks.testDb = createTestDb();
	embeddingsMock.mockReset();
	resolveMock.mockReset();
	resolveMock.mockReturnValue(CFG);
});

afterEach(() => closeTestDb());

describe('recallMemoryTool availability', () => {
	it('is always advertised (no embeddings gate) — the ids path needs no model', () => {
		// isAvailable is intentionally undefined: recall is gated only by the
		// 'personalization' category, so recall-by-id works without embeddings.
		expect(recallMemoryTool.isAvailable).toBeUndefined();
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
		setMemoryEmbedding(a.id, 'alpha note', encodeVector([1, 0]), MODEL);
		setMemoryEmbedding(b.id, 'beta note', encodeVector([0, 1]), MODEL);
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
		setMemoryEmbedding(a.id, 'the quokka migration plan', encodeVector([1, 0]), MODEL);
		embeddingsMock.mockRejectedValue(new Error('endpoint down'));

		const { res, parsed } = await run('quokka');
		expect(res.isError).toBeFalsy();
		expect(parsed.matches.map((m: { id: string }) => m.id)).toContain(a.id);
	});

	it('ignores rows embedded by a different model (incomparable vector space)', async () => {
		const u = seedUser();
		ctx.userId = u.id;
		const a = createMemory(u.id, 'stale model row');
		setMemoryEmbedding(a.id, 'stale model row', encodeVector([1, 0, 0]), 'old-model'); // wrong dim + model
		mockQueryVec([1, 0]); // current-model query vec (dim 2)

		// Dense leg must skip the stale-model row rather than dimension-mismatch
		// throw; BM25 still returns it. The point: no crash, result still comes.
		const { res, parsed } = await run('stale');
		expect(res.isError).toBeFalsy();
		expect(parsed.matches.map((m: { id: string }) => m.id)).toContain(a.id);
	});

	it('runs the BM25 query path (no error) when no embedding model is configured', async () => {
		resolveMock.mockReturnValue(undefined); // no [embeddings] configured
		const u = seedUser();
		ctx.userId = u.id;
		createMemory(u.id, 'the quokka migration plan', 'Quokka');

		const { res, parsed } = await run('quokka');
		expect(res.isError).toBeFalsy();
		expect(parsed.matches.map((m: { content: string }) => m.content)).toContain(
			'the quokka migration plan',
		);
		// The dense leg must not be attempted without a model.
		expect(embeddingsMock).not.toHaveBeenCalled();
	});

	it('includes each match’s topic in the result', async () => {
		const u = seedUser();
		ctx.userId = u.id;
		createMemory(u.id, 'the quokka migration plan', 'Quokka');
		mockQueryVec([1, 0]);
		const { parsed } = await run('quokka');
		expect(parsed.matches[0].topic).toBe('Quokka');
	});

	describe('ids path', () => {
		it('returns exactly the requested rows, no ranking, no embedding call', async () => {
			resolveMock.mockReturnValue(undefined); // works without embeddings
			const u = seedUser();
			ctx.userId = u.id;
			const a = createMemory(u.id, 'alpha note', 'Alpha');
			createMemory(u.id, 'beta note', 'Beta');
			const c = createMemory(u.id, 'gamma note', 'Gamma');

			const { res, parsed } = await runArgs({ ids: [a.id, c.id] });
			expect(res.isError).toBeFalsy();
			expect(parsed.matches.map((m: { id: string }) => m.id).sort()).toEqual([a.id, c.id].sort());
			expect(embeddingsMock).not.toHaveBeenCalled();
		});

		it('silently drops foreign / fabricated ids (user-scoped)', async () => {
			const u1 = seedUser();
			const u2 = seedUser();
			ctx.userId = u1.id;
			const mine = createMemory(u1.id, 'mine', 'Mine');
			const theirs = createMemory(u2.id, 'theirs', 'Theirs');

			const { parsed } = await runArgs({ ids: [mine.id, theirs.id, 'fabricated'] });
			expect(parsed.matches.map((m: { id: string }) => m.id)).toEqual([mine.id]);
		});

		it('takes precedence over a query when both are supplied', async () => {
			const u = seedUser();
			ctx.userId = u.id;
			const a = createMemory(u.id, 'alpha note', 'Alpha');
			createMemory(u.id, 'beta note', 'Beta');

			const { parsed } = await runArgs({ ids: [a.id], query: 'beta' });
			expect(parsed.matches.map((m: { id: string }) => m.id)).toEqual([a.id]);
			expect(embeddingsMock).not.toHaveBeenCalled();
		});
	});

	it('returns a recoverable error when neither query nor ids is provided', async () => {
		const u = seedUser();
		ctx.userId = u.id;
		const res = await recallMemoryTool.execute({}, ctx);
		expect(res.isError).toBe(true);
	});
});
