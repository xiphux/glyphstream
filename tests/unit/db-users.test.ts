/**
 * `users` is the single-row identity anchor after the PR 1 refactor:
 * provider-agnostic, created exactly once via `/setup`, never
 * upserted from a login path. These tests cover the single-user-cap
 * enforcement, the small read helpers used by session validation and
 * the `/setup` gate, and the lifecycle around `last_login_at` /
 * `disabled_at`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestDb, closeTestDb, type TestDB } from './_helpers/test-db';

const mocks = vi.hoisted(() => ({ testDb: null as unknown as TestDB }));
vi.mock('$lib/server/db/client', () => ({
	getDb: () => mocks.testDb,
	closeDb: () => {},
}));

import {
	bumpUserLastLogin,
	countUsers,
	createInitialUser,
	getDisabledAt,
} from '$lib/server/db/queries/users';
import { users } from '$lib/server/db/schema';

beforeEach(() => {
	mocks.testDb = createTestDb();
});

afterEach(() => {
	closeTestDb();
});

describe('createInitialUser', () => {
	it('inserts a user with the supplied display name + email', () => {
		const before = Date.now();
		const id = createInitialUser({ displayName: 'Operator', email: 'op@example.test' });
		const after = Date.now();

		const row = mocks.testDb.select().from(users).where(eq(users.id, id)).get()!;
		expect(row.displayName).toBe('Operator');
		expect(row.email).toBe('op@example.test');
		expect(row.disabledAt).toBeNull();
		expect(row.createdAt).toBeGreaterThanOrEqual(before);
		expect(row.createdAt).toBeLessThanOrEqual(after);
		expect(row.lastLoginAt).toBe(row.createdAt);
	});

	it('accepts a null email', () => {
		const id = createInitialUser({ displayName: 'Operator', email: null });
		const row = mocks.testDb.select().from(users).where(eq(users.id, id)).get()!;
		expect(row.email).toBeNull();
	});

	it('honors a pre-allocated id (passkey /setup flow needs this)', () => {
		const fixedId = 'pre-allocated-uuid';
		const returned = createInitialUser({ id: fixedId, displayName: 'Op', email: null });
		expect(returned).toBe(fixedId);
		expect(countUsers()).toBe(1);
	});

	it('throws when a user already exists — single-user-cap', () => {
		createInitialUser({ displayName: 'First', email: null });
		expect(() => createInitialUser({ displayName: 'Second', email: null })).toThrow(
			/setup is closed/i,
		);
	});
});

describe('countUsers', () => {
	it('returns 0 on an empty users table', () => {
		expect(countUsers()).toBe(0);
	});

	it('returns 1 after the initial user is created', () => {
		createInitialUser({ displayName: 'Op', email: null });
		expect(countUsers()).toBe(1);
	});
});

describe('getDisabledAt', () => {
	it('returns null for an active user', () => {
		const id = createInitialUser({ displayName: 'Op', email: null });
		expect(getDisabledAt(id)).toBeNull();
	});

	it('returns the stored timestamp for a disabled user', () => {
		const id = createInitialUser({ displayName: 'Op', email: null });
		mocks.testDb.update(users).set({ disabledAt: 1_700_000_000_000 }).where(eq(users.id, id)).run();
		expect(getDisabledAt(id)).toBe(1_700_000_000_000);
	});

	it('returns null for an unknown user id', () => {
		expect(getDisabledAt('does-not-exist')).toBeNull();
	});
});

describe('bumpUserLastLogin', () => {
	it('bumps last_login_at without touching other fields', async () => {
		const id = createInitialUser({ displayName: 'Op', email: 'op@x' });
		const before = mocks.testDb.select().from(users).where(eq(users.id, id)).get()!;
		await new Promise((r) => setTimeout(r, 2));
		bumpUserLastLogin(id);
		const after = mocks.testDb.select().from(users).where(eq(users.id, id)).get()!;
		expect(after.lastLoginAt!).toBeGreaterThan(before.lastLoginAt!);
		expect(after.displayName).toBe(before.displayName);
		expect(after.email).toBe(before.email);
		expect(after.createdAt).toBe(before.createdAt);
		expect(after.disabledAt).toBeNull();
	});

	it('is a no-op when the id does not match a row', () => {
		expect(() => bumpUserLastLogin('does-not-exist')).not.toThrow();
	});
});
