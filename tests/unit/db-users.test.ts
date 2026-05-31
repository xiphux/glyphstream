/**
 * upsertUserByGithub is the gate every login flows through. The
 * "stable internal id across re-logins" + "refresh upstream profile
 * fields on every login" contract is what lets the rest of the app
 * key everything off our internal id rather than chasing GitHub's
 * mutable username.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestDb, closeTestDb, type TestDB } from './_helpers/test-db';

const mocks = vi.hoisted(() => ({ testDb: null as unknown as TestDB }));
vi.mock('$lib/server/db/client', () => ({
	getDb: () => mocks.testDb,
	closeDb: () => {},
}));

import { upsertUserByGithub } from '$lib/server/db/queries/users';
import { users } from '$lib/server/db/schema';

beforeEach(() => {
	mocks.testDb = createTestDb();
});

afterEach(() => {
	closeTestDb();
});

describe('upsertUserByGithub', () => {
	it('inserts a brand-new user and returns its id', () => {
		const id = upsertUserByGithub({
			githubUserId: 42,
			githubUsername: 'octocat',
			email: 'octocat@example.com',
			displayName: 'The Octocat',
		});
		expect(typeof id).toBe('string');
		const row = mocks.testDb.select().from(users).where(eq(users.id, id)).get();
		expect(row).toBeDefined();
		expect(row!.githubUserId).toBe(42);
		expect(row!.githubUsername).toBe('octocat');
		expect(row!.email).toBe('octocat@example.com');
		expect(row!.displayName).toBe('The Octocat');
		expect(row!.createdAt).toBeGreaterThan(0);
		expect(row!.lastLoginAt).toBe(row!.createdAt);
	});

	it('reuses the same internal id when the same github_user_id logs in again', () => {
		// The whole reason we don't key off github_username — usernames can
		// be renamed/recycled; the numeric user id is stable. Internal id
		// must NOT shift on re-login or every FK in the DB points at orphan.
		const first = upsertUserByGithub({
			githubUserId: 42,
			githubUsername: 'octocat',
			email: null,
			displayName: null,
		});
		const second = upsertUserByGithub({
			githubUserId: 42,
			githubUsername: 'octocat',
			email: null,
			displayName: null,
		});
		expect(second).toBe(first);
	});

	it('refreshes username/email/displayName/lastLoginAt on subsequent logins', () => {
		const id = upsertUserByGithub({
			githubUserId: 42,
			githubUsername: 'old-name',
			email: 'old@example.com',
			displayName: 'Old Name',
		});
		const beforeRow = mocks.testDb.select().from(users).where(eq(users.id, id)).get()!;

		// Advance the clock so lastLoginAt visibly updates.
		const after = beforeRow.lastLoginAt! + 1000;
		vi.useFakeTimers();
		vi.setSystemTime(after);
		try {
			upsertUserByGithub({
				githubUserId: 42,
				githubUsername: 'new-name',
				email: 'new@example.com',
				displayName: 'New Name',
			});
		} finally {
			vi.useRealTimers();
		}

		const row = mocks.testDb.select().from(users).where(eq(users.id, id)).get()!;
		expect(row.githubUsername).toBe('new-name');
		expect(row.email).toBe('new@example.com');
		expect(row.displayName).toBe('New Name');
		expect(row.lastLoginAt).toBe(after);
		// created_at is immutable — it's "first ever sign-in time," not "most
		// recent activity time." Don't rewrite history.
		expect(row.createdAt).toBe(beforeRow.createdAt);
	});

	it('issues distinct internal ids for distinct github users', () => {
		const a = upsertUserByGithub({
			githubUserId: 1,
			githubUsername: 'a',
			email: null,
			displayName: null,
		});
		const b = upsertUserByGithub({
			githubUserId: 2,
			githubUsername: 'b',
			email: null,
			displayName: null,
		});
		expect(a).not.toBe(b);
	});

	it('accepts null email and displayName on insert', () => {
		const id = upsertUserByGithub({
			githubUserId: 99,
			githubUsername: 'minimal',
			email: null,
			displayName: null,
		});
		const row = mocks.testDb.select().from(users).where(eq(users.id, id)).get()!;
		expect(row.email).toBeNull();
		expect(row.displayName).toBeNull();
	});

	it('overwrites previously-set email/displayName back to null when GitHub clears them', () => {
		const id = upsertUserByGithub({
			githubUserId: 42,
			githubUsername: 'octo',
			email: 'set@example.com',
			displayName: 'Set Name',
		});
		upsertUserByGithub({
			githubUserId: 42,
			githubUsername: 'octo',
			email: null,
			displayName: null,
		});
		const row = mocks.testDb.select().from(users).where(eq(users.id, id)).get()!;
		expect(row.email).toBeNull();
		expect(row.displayName).toBeNull();
	});
});
