import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestDb, closeTestDb, type TestDB } from './_helpers/test-db';
import { seedUser } from './_helpers/seed';

const mocks = vi.hoisted(() => ({ testDb: null as unknown as TestDB }));
vi.mock('$lib/server/db/client', () => ({
	getDb: () => mocks.testDb,
	closeDb: () => {},
}));

import {
	composeMemorySection,
	createMemory,
	deleteMemory,
	listMemoriesForUser,
	listMemoriesNeedingEmbedding,
	listMemoriesNeedingTopic,
	listMemoriesWithEmbeddings,
	listMemoryBodies,
	listMemoryTierRows,
	MEMORY_INLINE_BUDGET_CHARS,
	memoryStats,
	recordMemoryRecall,
	setMemoryEmbedding,
	setMemoryTopic,
	updateMemory,
} from '$lib/server/db/queries/memories';
import { encodeVector } from '$lib/server/retrieval/vector';
import { memories, users } from '$lib/server/db/schema';

beforeEach(() => {
	mocks.testDb = createTestDb();
});

afterEach(() => {
	closeTestDb();
});

describe('createMemory + listMemoriesForUser', () => {
	it('returns an empty array for a user with no memories', () => {
		const u = seedUser();
		expect(listMemoriesForUser(u.id)).toEqual([]);
	});

	it('returns saved memories oldest-first', async () => {
		const u = seedUser();
		const a = createMemory(u.id, 'first fact');
		// Force a distinct millisecond timestamp so ordering is unambiguous —
		// the asc() index doesn't break ties by id.
		await new Promise((r) => setTimeout(r, 2));
		const b = createMemory(u.id, 'second fact');
		const list = listMemoriesForUser(u.id);
		expect(list.map((m) => m.id)).toEqual([a.id, b.id]);
		expect(list[0].content).toBe('first fact');
		expect(list[1].content).toBe('second fact');
	});

	it('scopes by user — does not return another user’s rows', () => {
		const u1 = seedUser();
		const u2 = seedUser();
		createMemory(u1.id, 'u1 fact');
		createMemory(u2.id, 'u2 fact');
		const list1 = listMemoriesForUser(u1.id);
		expect(list1).toHaveLength(1);
		expect(list1[0].content).toBe('u1 fact');
	});

	it('sets createdAt and updatedAt at creation', () => {
		const u = seedUser();
		const before = Date.now();
		const { id } = createMemory(u.id, 'fact');
		const after = Date.now();
		const m = listMemoriesForUser(u.id).find((x) => x.id === id)!;
		expect(m.createdAt).toBeGreaterThanOrEqual(before);
		expect(m.createdAt).toBeLessThanOrEqual(after);
		expect(m.updatedAt).toBe(m.createdAt);
	});
});

describe('updateMemory', () => {
	it('replaces content and bumps updatedAt', async () => {
		const u = seedUser();
		const { id } = createMemory(u.id, 'original');
		const originalUpdatedAt = listMemoriesForUser(u.id)[0].updatedAt;
		await new Promise((r) => setTimeout(r, 2));
		const matched = updateMemory(u.id, id, 'revised');
		expect(matched).toBe(true);
		const m = listMemoriesForUser(u.id)[0];
		expect(m.content).toBe('revised');
		expect(m.updatedAt).toBeGreaterThan(originalUpdatedAt);
	});

	it('returns false and changes nothing for a foreign user’s id', () => {
		const u1 = seedUser();
		const u2 = seedUser();
		const { id } = createMemory(u1.id, 'u1 fact');
		const matched = updateMemory(u2.id, id, 'pwn');
		expect(matched).toBe(false);
		expect(listMemoriesForUser(u1.id)[0].content).toBe('u1 fact');
	});

	it('returns false for a fabricated id without throwing', () => {
		const u = seedUser();
		expect(updateMemory(u.id, 'does-not-exist', 'whatever')).toBe(false);
	});
});

describe('deleteMemory', () => {
	it('removes the row and returns true', () => {
		const u = seedUser();
		const { id } = createMemory(u.id, 'fact');
		expect(deleteMemory(u.id, id)).toBe(true);
		expect(listMemoriesForUser(u.id)).toEqual([]);
	});

	it('returns false and changes nothing for a foreign user’s id', () => {
		const u1 = seedUser();
		const u2 = seedUser();
		const { id } = createMemory(u1.id, 'u1 fact');
		expect(deleteMemory(u2.id, id)).toBe(false);
		expect(listMemoriesForUser(u1.id)).toHaveLength(1);
	});

	it('returns false for a fabricated id', () => {
		const u = seedUser();
		expect(deleteMemory(u.id, 'does-not-exist')).toBe(false);
	});

	it('cascade-deletes when the user is deleted', () => {
		const u = seedUser();
		createMemory(u.id, 'fact');
		// Drop the user; FK ON DELETE CASCADE should sweep memories with it.
		mocks.testDb.delete(users).where(eq(users.id, u.id)).run();
		expect(listMemoriesForUser(u.id)).toEqual([]);
	});
});

describe('embedding columns', () => {
	const MODEL = 'embed-v1';

	it('updateMemory nulls the stored embedding so it gets re-embedded', () => {
		const u = seedUser();
		const { id } = createMemory(u.id, 'original');
		setMemoryEmbedding(id, 'original', encodeVector([1, 2, 3]), MODEL);
		expect(listMemoriesWithEmbeddings(u.id)[0].embedding).not.toBeNull();

		updateMemory(u.id, id, 'revised');
		const row = listMemoriesWithEmbeddings(u.id)[0];
		expect(row.embedding).toBeNull();
		expect(row.embeddingModel).toBeNull();
	});

	it('setMemoryEmbedding persists the vector + model without bumping updatedAt', () => {
		const u = seedUser();
		const { id } = createMemory(u.id, 'fact');
		const before = listMemoriesForUser(u.id)[0].updatedAt;
		setMemoryEmbedding(id, 'fact', encodeVector([0.5, 0.5]), MODEL);
		const row = listMemoriesWithEmbeddings(u.id)[0];
		expect(row.embeddingModel).toBe(MODEL);
		expect(row.embedding).not.toBeNull();
		expect(row.updatedAt).toBe(before);
	});

	it('setMemoryEmbedding no-ops (returns false) when content changed since read', () => {
		const u = seedUser();
		const { id } = createMemory(u.id, 'original');
		// Simulate the worker's read→await→write race: content was edited (and the
		// vector nulled) between the queue read and the write-back.
		updateMemory(u.id, id, 'revised');
		const matched = setMemoryEmbedding(id, 'original', encodeVector([1, 2, 3]), MODEL);
		expect(matched).toBe(false);
		// The stale write must NOT land — the row stays NULL so it re-queues.
		const row = listMemoriesWithEmbeddings(u.id)[0];
		expect(row.embedding).toBeNull();
		expect(listMemoriesNeedingEmbedding(MODEL, 10).map((r) => r.id)).toContain(id);
	});

	it('setMemoryEmbedding returns true and writes when content is unchanged', () => {
		const u = seedUser();
		const { id } = createMemory(u.id, 'fact');
		expect(setMemoryEmbedding(id, 'fact', encodeVector([1, 0]), MODEL)).toBe(true);
		expect(listMemoriesWithEmbeddings(u.id)[0].embedding).not.toBeNull();
	});

	it('listMemoriesNeedingEmbedding picks NULL and stale-model rows, cross-user', () => {
		const u1 = seedUser();
		const u2 = seedUser();
		const fresh = createMemory(u1.id, 'fresh — never embedded');
		const stale = createMemory(u1.id, 'stale — old model');
		const current = createMemory(u2.id, 'current — up to date');
		setMemoryEmbedding(stale.id, 'stale — old model', encodeVector([1]), 'old-model');
		setMemoryEmbedding(current.id, 'current — up to date', encodeVector([1]), MODEL);

		const ids = listMemoriesNeedingEmbedding(MODEL, 100).map((r) => r.id);
		expect(ids).toContain(fresh.id);
		expect(ids).toContain(stale.id);
		expect(ids).not.toContain(current.id);
	});

	it('listMemoriesNeedingEmbedding honors the limit', () => {
		const u = seedUser();
		createMemory(u.id, 'a');
		createMemory(u.id, 'b');
		createMemory(u.id, 'c');
		expect(listMemoriesNeedingEmbedding(MODEL, 2)).toHaveLength(2);
	});
});

describe('memoryStats', () => {
	it('returns zeroes for a user with no memories', () => {
		const u = seedUser();
		expect(memoryStats(u.id)).toEqual({ count: 0, totalChars: 0 });
	});

	it('counts rows and sums content length, scoped per user', () => {
		const u1 = seedUser();
		const u2 = seedUser();
		createMemory(u1.id, 'abc'); // 3
		createMemory(u1.id, 'de'); // 2
		createMemory(u2.id, 'zzzzz'); // 5 — must not leak into u1's stats
		expect(memoryStats(u1.id)).toEqual({ count: 2, totalChars: 5 });
		expect(memoryStats(u2.id)).toEqual({ count: 1, totalChars: 5 });
	});

	it('totalChars drives the inline-vs-recall budget check', () => {
		const u = seedUser();
		// One small memory stays under budget (inline mode).
		createMemory(u.id, 'x'.repeat(100));
		expect(memoryStats(u.id).totalChars).toBeLessThanOrEqual(MEMORY_INLINE_BUDGET_CHARS);
		// Enough bodies cross the budget → recall mode.
		for (let i = 0; i < 20; i++) createMemory(u.id, 'x'.repeat(300));
		const stats = memoryStats(u.id);
		expect(stats.count).toBe(21);
		expect(stats.totalChars).toBe(6100);
		expect(stats.totalChars).toBeGreaterThan(MEMORY_INLINE_BUDGET_CHARS);
	});
});

describe('createMemory + updateMemory topic', () => {
	it('persists a topic supplied at creation', () => {
		const u = seedUser();
		const { id } = createMemory(u.id, 'has a golden retriever named Max', 'Pet');
		const row = listMemoryTierRows(u.id).find((r) => r.id === id)!;
		expect(row.topic).toBe('Pet');
	});

	it('defaults topic to null when omitted', () => {
		const u = seedUser();
		const { id } = createMemory(u.id, 'some fact');
		expect(listMemoryTierRows(u.id).find((r) => r.id === id)!.topic).toBeNull();
	});

	it('updateMemory overwrites the topic when provided', () => {
		const u = seedUser();
		const { id } = createMemory(u.id, 'works at Acme', 'Employer');
		updateMemory(u.id, id, 'works at Globex', 'Employer (updated)');
		expect(listMemoryTierRows(u.id)[0].topic).toBe('Employer (updated)');
	});

	it('updateMemory leaves the topic untouched when omitted', () => {
		const u = seedUser();
		const { id } = createMemory(u.id, 'works at Acme', 'Employer');
		updateMemory(u.id, id, 'works at Acme Corp');
		expect(listMemoryTierRows(u.id)[0].topic).toBe('Employer');
	});
});

describe('listMemoryTierRows', () => {
	it('returns id/topic/snippet + len + counters, oldest-first, scoped per user', async () => {
		const u1 = seedUser();
		const u2 = seedUser();
		const a = createMemory(u1.id, 'a'.repeat(200), 'Long one');
		await new Promise((r) => setTimeout(r, 2));
		const b = createMemory(u1.id, 'short body', 'Short one');
		createMemory(u2.id, 'other user', 'Nope');
		recordMemoryRecall(u1.id, [b.id]);

		const rows = listMemoryTierRows(u1.id);
		expect(rows.map((r) => r.id)).toEqual([a.id, b.id]);
		expect(rows[0].topic).toBe('Long one');
		// Snippet is the leading 80 chars (fallback label for null topics); len is
		// the FULL body length, not the snippet length.
		expect(rows[0].snippet).toBe('a'.repeat(80));
		expect(rows[0].len).toBe(200);
		expect(rows[1].snippet).toBe('short body');
		// Recall counters ride along for scoring.
		expect(rows[0].recallCount).toBe(0);
		expect(rows[0].lastRecalledAt).toBeNull();
		expect(rows[1].recallCount).toBe(1);
		expect(rows[1].lastRecalledAt).not.toBeNull();
	});
});

describe('listMemoryBodies', () => {
	it('returns full bodies for only the requested ids, oldest-first', async () => {
		const u = seedUser();
		const a = createMemory(u.id, 'body a', 'A');
		await new Promise((r) => setTimeout(r, 2));
		const b = createMemory(u.id, 'body b', 'B');
		createMemory(u.id, 'body c', 'C');
		const bodies = listMemoryBodies(u.id, [b.id, a.id]);
		expect(bodies.map((m) => m.id)).toEqual([a.id, b.id]); // createdAt order
		expect(bodies.map((m) => m.content)).toEqual(['body a', 'body b']);
	});

	it('returns [] for an empty id list without a query', () => {
		const u = seedUser();
		createMemory(u.id, 'body', 'T');
		expect(listMemoryBodies(u.id, [])).toEqual([]);
	});

	it('does not return another user’s rows', () => {
		const u1 = seedUser();
		const u2 = seedUser();
		const mine = createMemory(u1.id, 'mine', 'Mine');
		const theirs = createMemory(u2.id, 'theirs', 'Theirs');
		const bodies = listMemoryBodies(u1.id, [mine.id, theirs.id]);
		expect(bodies.map((m) => m.id)).toEqual([mine.id]);
	});
});

describe('topic backfill queue (listMemoriesNeedingTopic / setMemoryTopic)', () => {
	it('lists only null-topic rows, honors the limit, across users', () => {
		const u1 = seedUser();
		const u2 = seedUser();
		const nullA = createMemory(u1.id, 'no topic a'); // topic defaults null
		createMemory(u1.id, 'has topic', 'Labelled'); // excluded
		const nullB = createMemory(u2.id, 'no topic b'); // other user, still queued

		const ids = listMemoriesNeedingTopic(100).map((r) => r.id);
		expect(ids.sort()).toEqual([nullA.id, nullB.id].sort());
		expect(listMemoriesNeedingTopic(1)).toHaveLength(1);
	});

	it('setMemoryTopic writes the topic and removes the row from the queue', () => {
		const u = seedUser();
		const { id } = createMemory(u.id, 'works at Acme');
		expect(setMemoryTopic(id, 'works at Acme', 'Employer')).toBe(true);
		expect(listMemoryTierRows(u.id)[0].topic).toBe('Employer');
		expect(listMemoriesNeedingTopic(100)).toHaveLength(0);
	});

	it('setMemoryTopic does not bump updatedAt (a backfill is not a content edit)', () => {
		const u = seedUser();
		const { id } = createMemory(u.id, 'fact');
		const before = listMemoriesForUser(u.id)[0].updatedAt;
		setMemoryTopic(id, 'fact', 'Topic');
		expect(listMemoriesForUser(u.id)[0].updatedAt).toBe(before);
	});

	it('setMemoryTopic no-ops when the content changed since it was read', () => {
		const u = seedUser();
		const { id } = createMemory(u.id, 'original');
		// A concurrent update_memory changed the body (and supplied its own topic)
		// between the worker's read and write.
		updateMemory(u.id, id, 'revised', 'Real topic');
		expect(setMemoryTopic(id, 'original', 'stale label')).toBe(false);
		expect(listMemoryTierRows(u.id)[0].topic).toBe('Real topic');
	});

	it('setMemoryTopic no-ops when a topic is already set (concurrent label wins)', () => {
		const u = seedUser();
		const { id } = createMemory(u.id, 'fact', 'Already labelled');
		expect(setMemoryTopic(id, 'fact', 'backfill guess')).toBe(false);
		expect(listMemoryTierRows(u.id)[0].topic).toBe('Already labelled');
	});
});

describe('recordMemoryRecall', () => {
	it('bumps recall_count and stamps last_recalled_at for the given ids', () => {
		const u = seedUser();
		const a = createMemory(u.id, 'fact a', 'A');
		const b = createMemory(u.id, 'fact b', 'B');
		const before = Date.now();
		recordMemoryRecall(u.id, [a.id]);
		const rowA = readMemoryCounters(a.id);
		const rowB = readMemoryCounters(b.id);
		expect(rowA.recallCount).toBe(1);
		expect(rowA.lastRecalledAt).toBeGreaterThanOrEqual(before);
		// The un-recalled row is untouched.
		expect(rowB.recallCount).toBe(0);
		expect(rowB.lastRecalledAt).toBeNull();
	});

	it('accumulates across calls', () => {
		const u = seedUser();
		const a = createMemory(u.id, 'fact a', 'A');
		recordMemoryRecall(u.id, [a.id]);
		recordMemoryRecall(u.id, [a.id]);
		expect(readMemoryCounters(a.id).recallCount).toBe(2);
	});

	it('is a no-op for an empty id list', () => {
		const u = seedUser();
		const a = createMemory(u.id, 'fact a', 'A');
		recordMemoryRecall(u.id, []);
		expect(readMemoryCounters(a.id).recallCount).toBe(0);
	});

	it('does not touch another user’s rows', () => {
		const u1 = seedUser();
		const u2 = seedUser();
		const a = createMemory(u1.id, 'u1 fact', 'A');
		recordMemoryRecall(u2.id, [a.id]);
		expect(readMemoryCounters(a.id).recallCount).toBe(0);
	});
});

describe('composeMemorySection', () => {
	it('returns null for an empty list', () => {
		expect(composeMemorySection([])).toBeNull();
	});

	it('returns null in recall mode with no index rows', () => {
		expect(composeMemorySection([], { recallMode: true })).toBeNull();
		expect(composeMemorySection([], { recallMode: true, index: [] })).toBeNull();
	});

	it('renders `[id] topic` (not bodies) under recallMode', () => {
		const out = composeMemorySection([], {
			recallMode: true,
			index: [
				{ id: 'a1', topic: 'Units', snippet: 'prefers metric units' },
				{ id: 'b2', topic: 'Employer', snippet: 'works at Acme' },
			],
		})!;
		expect(out).toContain('[a1] Units');
		expect(out).toContain('[b2] Employer');
		// The bodies (snippets) must NOT be inlined when a topic exists.
		expect(out).not.toContain('prefers metric units');
		expect(out).not.toContain('works at Acme');
	});

	it('falls back to the snippet when a topic is null', () => {
		const out = composeMemorySection([], {
			recallMode: true,
			index: [{ id: 'a1', topic: null, snippet: 'works at Acme as a staff eng' }],
		})!;
		expect(out).toContain('[a1] works at Acme as a staff eng');
	});

	it('recall-mode header points at recall_memory (ids + query) and the write tools', () => {
		const out = composeMemorySection([], {
			recallMode: true,
			index: [{ id: 'a1', topic: 'Units', snippet: 's' }],
		})!;
		expect(out).toMatch(/recall_memory/);
		expect(out).toMatch(/ids/);
		expect(out).toMatch(/update_memory/);
		expect(out).toMatch(/forget_memory/);
		expect(out).toMatch(/save_memory/);
	});

	it('tiered mode renders hot bodies in full above the cold topic index', () => {
		const out = composeMemorySection(
			[{ id: 'h1', content: 'full hot body one', createdAt: 0, updatedAt: 0 }],
			{
				recallMode: true,
				index: [{ id: 'c1', topic: 'Cold topic', snippet: 'cold snippet' }],
			},
		)!;
		// Hot body inlined in full...
		expect(out).toContain('[h1] full hot body one');
		// ...cold entry as topic only (not its snippet/body)...
		expect(out).toContain('[c1] Cold topic');
		expect(out).not.toContain('cold snippet');
		// ...header explains the split and points at recall_memory for the tail.
		expect(out).toMatch(/shown in full/);
		expect(out).toMatch(/recall_memory/);
	});

	it('tiered mode with an empty cold tail renders only the hot bodies', () => {
		const out = composeMemorySection(
			[{ id: 'h1', content: 'hot body', createdAt: 0, updatedAt: 0 }],
			{
				recallMode: true,
				index: [],
			},
		)!;
		expect(out).toContain('[h1] hot body');
		// No cold divider block when there's no tail.
		expect(out).not.toMatch(/More saved memories/);
	});

	it('renders each memory as `[id] content` inline (under budget)', () => {
		const out = composeMemorySection([
			{ id: 'a1', content: 'prefers metric units', createdAt: 0, updatedAt: 0 },
			{ id: 'b2', content: 'works at Acme', createdAt: 1, updatedAt: 1 },
		])!;
		expect(out).toContain('[a1] prefers metric units');
		expect(out).toContain('[b2] works at Acme');
	});

	it('includes the inline header explaining the index and the write tools', () => {
		const out = composeMemorySection([{ id: 'a', content: 'fact', createdAt: 0, updatedAt: 0 }])!;
		expect(out).toMatch(/Saved memories/);
		expect(out).toMatch(/forget_memory/);
		expect(out).toMatch(/update_memory/);
		expect(out).toMatch(/save_memory/);
	});
});

/** Read the raw recall-frequency counters for a memory row straight from the
 *  table — a tight check for the recordMemoryRecall tests (listMemoryTierRows
 *  also surfaces these, but going direct keeps these assertions column-exact). */
function readMemoryCounters(id: string): { recallCount: number; lastRecalledAt: number | null } {
	const row = mocks.testDb
		.select({ recallCount: memories.recallCount, lastRecalledAt: memories.lastRecalledAt })
		.from(memories)
		.where(eq(memories.id, id))
		.get()!;
	return row;
}
