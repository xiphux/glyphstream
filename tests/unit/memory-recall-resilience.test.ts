import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDb, closeTestDb, type TestDB } from './_helpers/test-db';
import { seedUser } from './_helpers/seed';

const mocks = vi.hoisted(() => ({ testDb: null as unknown as TestDB }));
vi.mock('$lib/server/db/client', () => ({
	getDb: () => mocks.testDb,
	closeDb: () => {},
}));

// No embeddings — exercise the pure-SQLite ids path (no dense leg to interfere).
vi.mock('$lib/server/retrieval/embeddings-config', () => ({
	resolveRelevanceConfig: () => undefined,
}));

// Partial-mock the queries module so we can force the telemetry write to throw
// while every other query stays real.
const recordMock = vi.hoisted(() => vi.fn());
vi.mock('$lib/server/db/queries/memories', async (importOriginal) => {
	const actual = await importOriginal<typeof import('$lib/server/db/queries/memories')>();
	return { ...actual, recordMemoryRecall: recordMock };
});

import { recallMemoryTool } from '$lib/server/tools/memory';
import { createMemory } from '$lib/server/db/queries/memories';

const ctx = {
	userId: '',
	conversationId: 'c1',
	signal: new AbortController().signal,
	disabledFeatures: [],
};

beforeEach(() => {
	mocks.testDb = createTestDb();
	recordMock.mockReset();
});
afterEach(() => closeTestDb());

describe('recall resilience: recall-frequency write is a non-essential side effect', () => {
	it('still returns the fetched memories when recordMemoryRecall throws', async () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const u = seedUser();
		ctx.userId = u.id;
		const a = createMemory(u.id, 'alpha note', 'Alpha');
		recordMock.mockImplementation(() => {
			throw new Error('disk full');
		});

		const res = await recallMemoryTool.execute({ ids: [a.id] }, ctx);

		// The telemetry write failed, but the read the model asked for must survive.
		expect(res.isError).toBeFalsy();
		expect(JSON.parse(res.content).matches.map((m: { id: string }) => m.id)).toEqual([a.id]);
		expect(recordMock).toHaveBeenCalled();
		warn.mockRestore();
	});
});
