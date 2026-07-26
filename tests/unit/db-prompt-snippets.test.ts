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
	bumpSnippetUsage,
	createPromptSnippet,
	deletePromptSnippet,
	getPromptSnippetForUser,
	listPromptSnippetsForUser,
	promptSnippetExistsByName,
	updatePromptSnippet,
} from '$lib/server/db/queries/prompt-snippets';
import { promptSnippets, users } from '$lib/server/db/schema';

beforeEach(() => {
	mocks.testDb = createTestDb();
});

afterEach(() => {
	closeTestDb();
});

describe('createPromptSnippet + listPromptSnippetsForUser', () => {
	it('returns an empty array for a user with no snippets', () => {
		const u = seedUser();
		expect(listPromptSnippetsForUser(u.id)).toEqual([]);
	});

	it('round-trips a snippet with kinds and tags', () => {
		const u = seedUser();
		const created = createPromptSnippet({
			userId: u.id,
			name: 'Akira Toriyama Style',
			body: 'clean and highly readable linework',
			kinds: ['image', 'video'],
			tags: ['anime', 'character'],
		});
		expect(created.usageCount).toBe(0);

		const [row] = listPromptSnippetsForUser(u.id);
		expect(row).toMatchObject({
			id: created.id,
			name: 'Akira Toriyama Style',
			body: 'clean and highly readable linework',
			kinds: ['image', 'video'],
			tags: ['anime', 'character'],
			usageCount: 0,
		});
	});

	it('treats omitted kinds/tags as empty (a generic snippet)', () => {
		const u = seedUser();
		createPromptSnippet({ userId: u.id, name: 'Terse', body: 'no preamble' });
		const [row] = listPromptSnippetsForUser(u.id);
		expect(row.kinds).toEqual([]);
		expect(row.tags).toEqual([]);
	});

	// The empty-as-NULL encoding is a deliberate storage shape, matching
	// custom-models' encodeDisabledFeatures — assert the column, not just the
	// parsed value, so a future refactor to '[]' is caught.
	it('stores empty kinds/tags as NULL rather than "[]"', () => {
		const u = seedUser();
		const s = createPromptSnippet({ userId: u.id, name: 'Terse', body: 'no preamble', kinds: [] });
		const raw = mocks.testDb.select().from(promptSnippets).where(eq(promptSnippets.id, s.id)).get();
		expect(raw?.kinds).toBeNull();
		expect(raw?.tags).toBeNull();
	});

	it('orders by name with an id tiebreak', () => {
		const u = seedUser();
		createPromptSnippet({ userId: u.id, name: 'Zebra', body: 'z' });
		createPromptSnippet({ userId: u.id, name: 'Anime', body: 'a' });
		createPromptSnippet({ userId: u.id, name: 'Mecha', body: 'm' });
		expect(listPromptSnippetsForUser(u.id).map((s) => s.name)).toEqual(['Anime', 'Mecha', 'Zebra']);
	});

	it('rejects a duplicate name for the same user', () => {
		const u = seedUser();
		createPromptSnippet({ userId: u.id, name: 'Anime', body: 'a' });
		expect(() => createPromptSnippet({ userId: u.id, name: 'Anime', body: 'b' })).toThrow();
	});

	it('allows the same name for different users', () => {
		const a = seedUser();
		const b = seedUser();
		createPromptSnippet({ userId: a.id, name: 'Anime', body: 'a' });
		expect(() => createPromptSnippet({ userId: b.id, name: 'Anime', body: 'b' })).not.toThrow();
	});
});

// The multi-user isolation invariant: every read scopes by user_id, so a
// foreign id must be indistinguishable from a nonexistent one.
describe('user scoping', () => {
	it('does not list, read, update, delete, or bump another user’s snippet', () => {
		const owner = seedUser();
		const other = seedUser();
		const s = createPromptSnippet({ userId: owner.id, name: 'Anime', body: 'a' });

		expect(listPromptSnippetsForUser(other.id)).toEqual([]);
		expect(getPromptSnippetForUser(s.id, other.id)).toBeNull();
		expect(updatePromptSnippet(s.id, other.id, { body: 'hacked' })).toBeNull();
		expect(deletePromptSnippet(s.id, other.id)).toBe(false);
		expect(bumpSnippetUsage(s.id, other.id)).toBe(false);

		expect(getPromptSnippetForUser(s.id, owner.id)?.body).toBe('a');
	});
});

describe('promptSnippetExistsByName', () => {
	it('is true only for the owner’s exact name', () => {
		const u = seedUser();
		const other = seedUser();
		createPromptSnippet({ userId: u.id, name: 'Anime', body: 'a' });
		expect(promptSnippetExistsByName(u.id, 'Anime')).toBe(true);
		expect(promptSnippetExistsByName(u.id, 'anime')).toBe(false);
		expect(promptSnippetExistsByName(other.id, 'Anime')).toBe(false);
	});
});

describe('updatePromptSnippet', () => {
	it('patches only the provided fields', () => {
		const u = seedUser();
		const s = createPromptSnippet({
			userId: u.id,
			name: 'Anime',
			body: 'a',
			kinds: ['image'],
			tags: ['x'],
		});
		const updated = updatePromptSnippet(s.id, u.id, { body: 'b' });
		expect(updated).toMatchObject({ name: 'Anime', body: 'b', kinds: ['image'], tags: ['x'] });
	});

	it('can clear kinds back to generic', () => {
		const u = seedUser();
		const s = createPromptSnippet({ userId: u.id, name: 'Anime', body: 'a', kinds: ['image'] });
		expect(updatePromptSnippet(s.id, u.id, { kinds: [] })?.kinds).toEqual([]);
	});

	it('returns null for an unknown id', () => {
		const u = seedUser();
		expect(updatePromptSnippet('nope', u.id, { body: 'b' })).toBeNull();
	});
});

describe('deletePromptSnippet', () => {
	it('removes the row and reports whether it matched', () => {
		const u = seedUser();
		const s = createPromptSnippet({ userId: u.id, name: 'Anime', body: 'a' });
		expect(deletePromptSnippet(s.id, u.id)).toBe(true);
		expect(listPromptSnippetsForUser(u.id)).toEqual([]);
		expect(deletePromptSnippet(s.id, u.id)).toBe(false);
	});
});

describe('bumpSnippetUsage', () => {
	it('increments the counter', () => {
		const u = seedUser();
		const s = createPromptSnippet({ userId: u.id, name: 'Anime', body: 'a' });
		expect(bumpSnippetUsage(s.id, u.id)).toBe(true);
		bumpSnippetUsage(s.id, u.id);
		expect(getPromptSnippetForUser(s.id, u.id)?.usageCount).toBe(2);
	});
});

// A snippet whose kinds column got mangled must stay VISIBLE (generic) rather
// than vanishing from every menu — the defensive-parse contract.
describe('garbage in the JSON columns', () => {
	it('degrades a malformed kinds/tags column to generic + untagged', () => {
		const u = seedUser();
		const s = createPromptSnippet({ userId: u.id, name: 'Anime', body: 'a', kinds: ['image'] });
		mocks.testDb
			.update(promptSnippets)
			.set({ kinds: 'not json at all', tags: '{"not":"an array"}' })
			.where(eq(promptSnippets.id, s.id))
			.run();
		const row = getPromptSnippetForUser(s.id, u.id);
		expect(row?.kinds).toEqual([]);
		expect(row?.tags).toEqual([]);
	});

	it('drops unknown kind entries but keeps valid ones', () => {
		const u = seedUser();
		const s = createPromptSnippet({ userId: u.id, name: 'Anime', body: 'a' });
		mocks.testDb
			.update(promptSnippets)
			.set({ kinds: JSON.stringify(['image', 'embedding', 'nonsense', 42]) })
			.where(eq(promptSnippets.id, s.id))
			.run();
		expect(getPromptSnippetForUser(s.id, u.id)?.kinds).toEqual(['image']);
	});
});

describe('cascade', () => {
	it('deletes a user’s snippets with the user', () => {
		const u = seedUser();
		createPromptSnippet({ userId: u.id, name: 'Anime', body: 'a' });
		mocks.testDb.delete(users).where(eq(users.id, u.id)).run();
		expect(listPromptSnippetsForUser(u.id)).toEqual([]);
	});
});
