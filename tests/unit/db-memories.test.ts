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
	updateMemory,
} from '$lib/server/db/queries/memories';
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

describe('composeMemorySection', () => {
	it('returns null for an empty list', () => {
		expect(composeMemorySection([])).toBeNull();
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
