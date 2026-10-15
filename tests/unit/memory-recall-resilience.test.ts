import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDb, closeTestDb } from './_helpers/test-db';
import { seedUser } from './_helpers/seed';

// No embeddings — exercise the pure-SQLite ids path (no dense leg to interfere).
vi.mock('#lib/server/retrieval/embeddings-config.js', () => ({
	resolveRelevanceConfig: () => undefined,
}));

// Partial-mock the queries module so we can force the telemetry write to throw
// while every other query stays real.
const recordMock = vi.hoisted(() => vi.fn());
vi.mock('#lib/server/db/queries/memories.js', async (importOriginal) => {
	const actual = await importOriginal<typeof import('#lib/server/db/queries/memories.js')>();
	return { ...actual, recordMemoryRecall: recordMock };
});

import { recallMemoryTool } from '#lib/server/tools/memory.js';
import { createMemory } from '#lib/server/db/queries/memories.js';

const ctx = {
	userId: '',
	conversationId: 'c1',
	signal: new AbortController().signal,
	disabledFeatures: [],
};

beforeEach(() => {
	createTestDb();
	recordMock.mockReset();
});
afterEach(() => closeTestDb());

/** What recall_memory serialises into `content`. Typed so the many
 *  `toEqual([])` assertions below can not pass against an absent field. */
type RecallPayload = { matches: Array<{ id: string; content: string; topic?: string | null }> };
const payload = (content: string) => JSON.parse(content) as RecallPayload;

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
		expect(payload(res.content).matches.map((m: { id: string }) => m.id)).toEqual([a.id]);
		expect(recordMock).toHaveBeenCalled();
		warn.mockRestore();
	});
});
