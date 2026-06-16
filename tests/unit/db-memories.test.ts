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
	listMemoriesWithEmbeddings,
	MEMORY_INLINE_BUDGET_CHARS,
	memoryStats,
	setMemoryEmbedding,
	updateMemory,
} from '$lib/server/db/queries/memories';
import { encodeVector } from '$lib/server/retrieval/vector';
import { users } from '$lib/server/db/schema';

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

describe('composeMemorySection', () => {
	it('returns null for an empty list', () => {
		expect(composeMemorySection([])).toBeNull();
	});

	it('returns null for an empty list even in recall mode', () => {
		expect(composeMemorySection([], { recallMode: true })).toBeNull();
	});

	it('emits a recall hint (not bodies) under recallMode', () => {
		const list = [
			{ id: 'a1', content: 'prefers metric units', createdAt: 0, updatedAt: 0 },
			{ id: 'b2', content: 'works at Acme', createdAt: 1, updatedAt: 1 },
		];
		const out = composeMemorySection(list, { recallMode: true })!;
		expect(out).toMatch(/recall_memory/);
		expect(out).toContain('2 saved memories');
		// The bodies must NOT be inlined in recall mode.
		expect(out).not.toContain('prefers metric units');
		expect(out).not.toContain('works at Acme');
	});

	it('uses recallCount for the hint when bodies are not loaded (recall mode)', () => {
		// Recall mode passes an empty list + an explicit count, so the prompt builder
		// never has to materialize every body just to size the store.
		const out = composeMemorySection([], { recallMode: true, recallCount: 7 })!;
		expect(out).toMatch(/recall_memory/);
		expect(out).toContain('7 saved memories');
	});

	it('recallCount of 0 yields no section even in recall mode', () => {
		expect(composeMemorySection([], { recallMode: true, recallCount: 0 })).toBeNull();
	});

	it('renders each memory as `[id] content` on its own line', () => {
		const out = composeMemorySection([
			{ id: 'a1', content: 'prefers metric units', createdAt: 0, updatedAt: 0 },
			{ id: 'b2', content: 'works at Acme', createdAt: 1, updatedAt: 1 },
		])!;
		expect(out).toContain('[a1] prefers metric units');
		expect(out).toContain('[b2] works at Acme');
	});

	it('includes the header explaining the index and the write tools', () => {
		const out = composeMemorySection([{ id: 'a', content: 'fact', createdAt: 0, updatedAt: 0 }])!;
		expect(out).toMatch(/Saved memories/);
		// The header must teach the model the id-bracketed convention and the
		// names of the write tools — otherwise it can't act on the index.
		expect(out).toMatch(/forget_memory/);
		expect(out).toMatch(/update_memory/);
		expect(out).toMatch(/save_memory/);
	});
});
