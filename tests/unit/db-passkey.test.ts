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
	countCredentialsForUser,
	deleteCredential,
	findCredentialById,
	findUserForCredential,
	insertCredential,
	listCredentialSummariesForUser,
	listCredentialsForUser,
	renameCredential,
	updateCredentialCounterAndLastUsed,
	type InsertPasskeyInput,
} from '$lib/server/db/queries/passkey';
import { passkeyCredentials, users } from '$lib/server/db/schema';

beforeEach(() => {
	mocks.testDb = createTestDb();
});

afterEach(() => {
	closeTestDb();
});

function makeInsert(
	userId: string,
	overrides: Partial<InsertPasskeyInput> = {},
): InsertPasskeyInput {
	// Explicit `'transports' in overrides` check so an intentional `null`
	// override actually overrides — `?? ['internal']` would substitute on
	// null and the "no transports" branch would never get tested.
	return {
		id: overrides.id ?? `cred-${Math.random().toString(36).slice(2)}`,
		userId,
		publicKey: overrides.publicKey ?? new Uint8Array([1, 2, 3, 4, 5]),
		counter: overrides.counter ?? 0,
		transports: 'transports' in overrides ? overrides.transports! : ['internal'],
		backedUp: overrides.backedUp ?? true,
		deviceType: overrides.deviceType ?? 'multiDevice',
		name: 'name' in overrides ? overrides.name! : null,
	};
}

describe('insertCredential + listCredentialsForUser', () => {
	it('returns an empty array for a user with no credentials', () => {
		const u = seedUser();
		expect(listCredentialsForUser(u.id)).toEqual([]);
	});

	it('round-trips public_key bytes as Uint8Array', () => {
		const u = seedUser();
		const key = new Uint8Array([0xde, 0xad, 0xbe, 0xef, 0x00, 0xff]);
		insertCredential(makeInsert(u.id, { id: 'c1', publicKey: key }));
		const [row] = listCredentialsForUser(u.id);
		expect(row.publicKey).toBeInstanceOf(Uint8Array);
		expect(Array.from(row.publicKey)).toEqual(Array.from(key));
	});

	it('returns rows oldest-first', async () => {
		const u = seedUser();
		insertCredential(makeInsert(u.id, { id: 'a' }));
		// Force a distinct millisecond timestamp on createdAt so ordering
		// is unambiguous — asc() doesn't break ties by id.
		await new Promise((r) => setTimeout(r, 2));
		insertCredential(makeInsert(u.id, { id: 'b' }));
		const list = listCredentialsForUser(u.id);
		expect(list.map((r) => r.id)).toEqual(['a', 'b']);
	});

	it('scopes by user — does not return another user’s credentials', () => {
		const u1 = seedUser();
		const u2 = seedUser();
		insertCredential(makeInsert(u1.id, { id: 'u1-cred' }));
		insertCredential(makeInsert(u2.id, { id: 'u2-cred' }));
		expect(listCredentialsForUser(u1.id).map((r) => r.id)).toEqual(['u1-cred']);
	});

	it('round-trips transports as a string array (and null when omitted)', () => {
		const u = seedUser();
		insertCredential(makeInsert(u.id, { id: 'with-transports', transports: ['usb', 'hybrid'] }));
		insertCredential(makeInsert(u.id, { id: 'no-transports', transports: null }));
		const map = new Map(listCredentialsForUser(u.id).map((r) => [r.id, r.transports]));
		expect(map.get('with-transports')).toEqual(['usb', 'hybrid']);
		expect(map.get('no-transports')).toBeNull();
	});

	it('drops unknown transport values without throwing', () => {
		const u = seedUser();
		insertCredential(makeInsert(u.id, { id: 'c1' }));
		// Simulate a future authenticator returning a transport we don't
		// recognize yet — we want to keep working, not crash login.
		mocks.testDb
			.update(passkeyCredentials)
			.set({ transportsJson: JSON.stringify(['internal', 'astral-projection']) })
			.where(eq(passkeyCredentials.id, 'c1'))
			.run();
		const [row] = listCredentialsForUser(u.id);
		expect(row.transports).toEqual(['internal']);
	});

	it('treats malformed transports JSON as null (no throw)', () => {
		const u = seedUser();
		insertCredential(makeInsert(u.id, { id: 'c1' }));
		mocks.testDb
			.update(passkeyCredentials)
			.set({ transportsJson: 'not json' })
			.where(eq(passkeyCredentials.id, 'c1'))
			.run();
		const [row] = listCredentialsForUser(u.id);
		expect(row.transports).toBeNull();
	});

	it('preserves backedUp + deviceType across the round-trip', () => {
		const u = seedUser();
		insertCredential(
			makeInsert(u.id, {
				id: 'platform',
				backedUp: false,
				deviceType: 'singleDevice',
			}),
		);
		insertCredential(makeInsert(u.id, { id: 'synced', backedUp: true, deviceType: 'multiDevice' }));
		const map = new Map(listCredentialsForUser(u.id).map((r) => [r.id, r]));
		expect(map.get('platform')?.backedUp).toBe(false);
		expect(map.get('platform')?.deviceType).toBe('singleDevice');
		expect(map.get('synced')?.backedUp).toBe(true);
		expect(map.get('synced')?.deviceType).toBe('multiDevice');
	});
});

describe('listCredentialSummariesForUser', () => {
	it('omits public_key and counter from the projection', () => {
		const u = seedUser();
		insertCredential(makeInsert(u.id, { id: 'c1', counter: 7 }));
		const [s] = listCredentialSummariesForUser(u.id);
		expect(s).not.toHaveProperty('publicKey');
		expect(s).not.toHaveProperty('counter');
		expect(s.id).toBe('c1');
	});
});

describe('findCredentialById', () => {
	it('returns the row across user boundaries (usernameless flow)', () => {
		const u1 = seedUser();
		const u2 = seedUser();
		insertCredential(makeInsert(u2.id, { id: 'u2-cred' }));
		// Caller has no user context — needs to look up by credential id alone.
		const found = findCredentialById('u2-cred');
		expect(found?.userId).toBe(u2.id);
		expect(u1.id).not.toBe(u2.id);
	});

	it('returns null for an unknown id', () => {
		expect(findCredentialById('does-not-exist')).toBeNull();
	});
});

describe('findUserForCredential', () => {
	it('joins through to the owning user', () => {
		const u = seedUser({ githubUserId: 4242, githubUsername: 'octocat' });
		insertCredential(makeInsert(u.id, { id: 'c1' }));
		const out = findUserForCredential('c1');
		expect(out).toEqual({
			userId: u.id,
			githubUserId: 4242,
			githubUsername: 'octocat',
		});
	});

	it('returns null for an unknown credential id', () => {
		expect(findUserForCredential('nope')).toBeNull();
	});
});

describe('updateCredentialCounterAndLastUsed', () => {
	it('bumps counter and last_used_at atomically without touching siblings', () => {
		const u = seedUser();
		insertCredential(makeInsert(u.id, { id: 'a', counter: 0 }));
		insertCredential(makeInsert(u.id, { id: 'b', counter: 0 }));
		updateCredentialCounterAndLastUsed('a', 5, 123_456);
		const map = new Map(listCredentialsForUser(u.id).map((r) => [r.id, r]));
		expect(map.get('a')?.counter).toBe(5);
		expect(map.get('a')?.lastUsedAt).toBe(123_456);
		expect(map.get('b')?.counter).toBe(0);
		expect(map.get('b')?.lastUsedAt).toBeNull();
	});
});

describe('renameCredential', () => {
	it('updates the name and returns true', () => {
		const u = seedUser();
		insertCredential(makeInsert(u.id, { id: 'c1', name: 'old' }));
		expect(renameCredential(u.id, 'c1', 'new')).toBe(true);
		expect(listCredentialsForUser(u.id)[0].name).toBe('new');
	});

	it('accepts null to clear a name', () => {
		const u = seedUser();
		insertCredential(makeInsert(u.id, { id: 'c1', name: 'pixel' }));
		expect(renameCredential(u.id, 'c1', null)).toBe(true);
		expect(listCredentialsForUser(u.id)[0].name).toBeNull();
	});

	it('returns false and changes nothing for a foreign user’s id', () => {
		const u1 = seedUser();
		const u2 = seedUser();
		insertCredential(makeInsert(u1.id, { id: 'c1', name: 'original' }));
		expect(renameCredential(u2.id, 'c1', 'pwn')).toBe(false);
		expect(listCredentialsForUser(u1.id)[0].name).toBe('original');
	});

	it('returns false for a fabricated id', () => {
		const u = seedUser();
		expect(renameCredential(u.id, 'does-not-exist', 'whatever')).toBe(false);
	});
});

describe('deleteCredential', () => {
	it('removes the row and returns true', () => {
		const u = seedUser();
		insertCredential(makeInsert(u.id, { id: 'c1' }));
		expect(deleteCredential(u.id, 'c1')).toBe(true);
		expect(listCredentialsForUser(u.id)).toEqual([]);
	});

	it('returns false and keeps the row for a foreign user’s id', () => {
		const u1 = seedUser();
		const u2 = seedUser();
		insertCredential(makeInsert(u1.id, { id: 'c1' }));
		expect(deleteCredential(u2.id, 'c1')).toBe(false);
		expect(listCredentialsForUser(u1.id)).toHaveLength(1);
	});

	it('cascade-deletes when the user is removed', () => {
		const u = seedUser();
		insertCredential(makeInsert(u.id, { id: 'c1' }));
		mocks.testDb.delete(users).where(eq(users.id, u.id)).run();
		expect(findCredentialById('c1')).toBeNull();
	});
});

describe('countCredentialsForUser', () => {
	it('counts only the named user’s rows', () => {
		const u1 = seedUser();
		const u2 = seedUser();
		insertCredential(makeInsert(u1.id, { id: 'a' }));
		insertCredential(makeInsert(u1.id, { id: 'b' }));
		insertCredential(makeInsert(u2.id, { id: 'c' }));
		expect(countCredentialsForUser(u1.id)).toBe(2);
		expect(countCredentialsForUser(u2.id)).toBe(1);
	});

	it('returns 0 when the user has no credentials', () => {
		const u = seedUser();
		expect(countCredentialsForUser(u.id)).toBe(0);
	});
});
