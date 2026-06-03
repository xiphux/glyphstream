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
	addOAuthAccount,
	countOAuthAccountsForUser,
	deleteOAuthAccount,
	findUserByOAuth,
	listOAuthAccountsForUser,
	touchOAuthAccount,
	type AddOAuthAccountInput,
} from '$lib/server/db/queries/oauth-accounts';
import { users } from '$lib/server/db/schema';

beforeEach(() => {
	mocks.testDb = createTestDb();
});

afterEach(() => {
	closeTestDb();
});

function makeInput(
	userId: string,
	overrides: Partial<AddOAuthAccountInput> = {},
): AddOAuthAccountInput {
	return {
		userId,
		provider: overrides.provider ?? 'github',
		externalId: overrides.externalId ?? '12345',
		externalUsername: 'externalUsername' in overrides ? overrides.externalUsername! : 'octocat',
		externalEmail: 'externalEmail' in overrides ? overrides.externalEmail! : 'cat@example.com',
	};
}

describe('addOAuthAccount + listOAuthAccountsForUser', () => {
	it('returns an empty array for a user with no bindings', () => {
		const u = seedUser();
		expect(listOAuthAccountsForUser(u.id)).toEqual([]);
	});

	it('round-trips provider, external_id, username, email', () => {
		const u = seedUser();
		addOAuthAccount(makeInput(u.id, { externalId: '99', externalUsername: 'alice' }));
		const [row] = listOAuthAccountsForUser(u.id);
		expect(row.provider).toBe('github');
		expect(row.externalId).toBe('99');
		expect(row.externalUsername).toBe('alice');
		expect(row.externalEmail).toBe('cat@example.com');
	});

	it('preserves nullability of externalUsername + externalEmail', () => {
		const u = seedUser();
		addOAuthAccount(
			makeInput(u.id, { externalUsername: null, externalEmail: null, externalId: '99' }),
		);
		const [row] = listOAuthAccountsForUser(u.id);
		expect(row.externalUsername).toBeNull();
		expect(row.externalEmail).toBeNull();
	});

	it('scopes by user — does not return another user’s bindings', () => {
		const u1 = seedUser();
		const u2 = seedUser();
		addOAuthAccount(makeInput(u1.id, { externalId: '11' }));
		addOAuthAccount(makeInput(u2.id, { externalId: '22' }));
		expect(listOAuthAccountsForUser(u1.id).map((r) => r.externalId)).toEqual(['11']);
	});

	it('orders oldest binding first', async () => {
		const u = seedUser();
		addOAuthAccount(makeInput(u.id, { externalId: 'first' }));
		// Distinct ms so the asc() ordering is unambiguous.
		await new Promise((r) => setTimeout(r, 2));
		addOAuthAccount(makeInput(u.id, { provider: 'google', externalId: 'second' }));
		const list = listOAuthAccountsForUser(u.id);
		expect(list.map((r) => r.externalId)).toEqual(['first', 'second']);
	});

	it('throws on UNIQUE (provider, external_id) conflict', () => {
		const u1 = seedUser();
		const u2 = seedUser();
		addOAuthAccount(makeInput(u1.id, { externalId: '42' }));
		expect(() => addOAuthAccount(makeInput(u2.id, { externalId: '42' }))).toThrow(/UNIQUE/i);
	});
});

describe('findUserByOAuth', () => {
	it('returns the bound user and propagates disabledAt = null', () => {
		const u = seedUser();
		addOAuthAccount(makeInput(u.id, { externalId: '777' }));
		const out = findUserByOAuth('github', '777');
		expect(out).toEqual({ userId: u.id, disabledAt: null });
	});

	it('propagates a non-null disabledAt from the joined users row', () => {
		const u = seedUser();
		addOAuthAccount(makeInput(u.id, { externalId: '777' }));
		mocks.testDb
			.update(users)
			.set({ disabledAt: 1_700_000_000_000 })
			.where(eq(users.id, u.id))
			.run();
		const out = findUserByOAuth('github', '777');
		expect(out?.disabledAt).toBe(1_700_000_000_000);
	});

	it('returns null for an unknown binding', () => {
		expect(findUserByOAuth('github', 'nope')).toBeNull();
	});

	it('distinguishes providers — same external_id, different providers', () => {
		const u = seedUser();
		addOAuthAccount(makeInput(u.id, { provider: 'github', externalId: '42' }));
		// UNIQUE is (provider, external_id) so this is legal.
		const u2 = seedUser();
		addOAuthAccount(
			makeInput(u2.id, { provider: 'google', externalId: '42', externalUsername: 'g-alice' }),
		);
		expect(findUserByOAuth('github', '42')?.userId).toBe(u.id);
		expect(findUserByOAuth('google', '42')?.userId).toBe(u2.id);
	});
});

describe('touchOAuthAccount', () => {
	it('updates externalUsername, externalEmail, and last_synced_at', async () => {
		const u = seedUser();
		addOAuthAccount(makeInput(u.id, { externalId: '5', externalUsername: 'old' }));
		const initial = listOAuthAccountsForUser(u.id)[0];
		await new Promise((r) => setTimeout(r, 2));

		touchOAuthAccount('github', '5', { externalUsername: 'new', externalEmail: 'new@x' });
		const [row] = listOAuthAccountsForUser(u.id);
		expect(row.externalUsername).toBe('new');
		expect(row.externalEmail).toBe('new@x');
		expect(row.createdAt).toBe(initial.createdAt);
	});

	it('is a no-op when the binding does not exist', () => {
		// Should not throw; just changes zero rows.
		expect(() =>
			touchOAuthAccount('github', 'nope', { externalUsername: null, externalEmail: null }),
		).not.toThrow();
	});
});

describe('deleteOAuthAccount', () => {
	it('removes the binding and returns true', () => {
		const u = seedUser();
		addOAuthAccount(makeInput(u.id, { externalId: 'x' }));
		expect(deleteOAuthAccount(u.id, 'github')).toBe(true);
		expect(listOAuthAccountsForUser(u.id)).toEqual([]);
	});

	it('returns false for a foreign user’s binding', () => {
		const u1 = seedUser();
		const u2 = seedUser();
		addOAuthAccount(makeInput(u1.id, { externalId: 'x' }));
		expect(deleteOAuthAccount(u2.id, 'github')).toBe(false);
		expect(listOAuthAccountsForUser(u1.id)).toHaveLength(1);
	});

	it('cascade-deletes when the user row is removed', () => {
		const u = seedUser();
		addOAuthAccount(makeInput(u.id, { externalId: 'x' }));
		mocks.testDb.delete(users).where(eq(users.id, u.id)).run();
		expect(findUserByOAuth('github', 'x')).toBeNull();
	});
});

describe('countOAuthAccountsForUser', () => {
	it('counts only the named user’s bindings', () => {
		const u1 = seedUser();
		const u2 = seedUser();
		addOAuthAccount(makeInput(u1.id, { provider: 'github', externalId: 'g1' }));
		addOAuthAccount(makeInput(u1.id, { provider: 'google', externalId: 'g2' }));
		addOAuthAccount(makeInput(u2.id, { provider: 'github', externalId: 'g3' }));
		expect(countOAuthAccountsForUser(u1.id)).toBe(2);
		expect(countOAuthAccountsForUser(u2.id)).toBe(1);
	});
});
