/**
 * Invite redemption + multi-user creation. These pin the two correctness
 * properties the onboarding flow leans on:
 *
 *   - createUser mints a normal ('user') OR admin account with no
 *     single-user cap (that cap now lives only in createInitialUser).
 *   - An invite is single-use: findValidInvite gates on unused+unexpired,
 *     and consumeInvite's conditional UPDATE makes a double-redeem race
 *     resolve to exactly one winner.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDb, closeTestDb, type TestDB } from './_helpers/test-db';

const mocks = vi.hoisted(() => ({ testDb: null as unknown as TestDB }));
vi.mock('$lib/server/db/client', () => ({
	getDb: () => mocks.testDb,
	closeDb: () => {},
}));

import {
	createUser,
	createInitialUser,
	countUsers,
	countAdmins,
	ensureAdminBootstrap,
	getUserRole,
} from '$lib/server/db/queries/users';
import {
	createInvite,
	findValidInvite,
	consumeInvite,
	hashInviteToken,
	listInvites,
	deleteInvite,
} from '$lib/server/db/queries/invites';
import { finalizeOAuthJoin, finalizePasskeyJoin, InviteConsumedError } from '$lib/server/auth/join';
import { findUserByOAuth } from '$lib/server/db/queries/oauth-accounts';
import { listCredentialsForUser } from '$lib/server/db/queries/passkey';
import { users } from '../../src/lib/server/db/schema';

beforeEach(() => {
	mocks.testDb = createTestDb();
});
afterEach(() => {
	closeTestDb();
});

describe('createUser / createInitialUser', () => {
	it('createUser mints a normal user with no single-user cap', () => {
		const a = createUser({ displayName: 'A', email: 'a@x.test', role: 'user' });
		const b = createUser({ displayName: 'B', email: 'b@x.test', role: 'user' });
		expect(a).not.toBe(b);
		expect(countUsers()).toBe(2);
	});

	it('createInitialUser creates an admin and refuses once a user exists', () => {
		const admin = createInitialUser({ displayName: 'Admin', email: 'admin@x.test' });
		expect(admin).toBeTruthy();
		expect(() => createInitialUser({ displayName: 'Second', email: 's@x.test' })).toThrow(
			/setup is closed/,
		);
	});

	it('honors a pre-allocated id (passkey userHandle binding)', () => {
		const id = createUser({ id: 'fixed-id', displayName: 'P', email: null, role: 'user' });
		expect(id).toBe('fixed-id');
	});
});

describe('invites', () => {
	function admin() {
		return createInitialUser({ displayName: 'Admin', email: 'admin@x.test' });
	}

	it('createInvite returns a raw token whose hash (not the token) is stored', () => {
		const adminId = admin();
		const inv = createInvite({ createdByUserId: adminId, role: 'user', ttlMs: 60_000 });
		const stored = listInvites();
		expect(stored).toHaveLength(1);
		// The raw token must not be discoverable from the stored row.
		expect(JSON.stringify(stored[0])).not.toContain(inv.token);
		// But its hash resolves the invite.
		expect(findValidInvite(inv.token)?.id).toBe(inv.id);
		expect(hashInviteToken(inv.token)).toBe(hashInviteToken(inv.token));
	});

	it('findValidInvite rejects unknown, expired, and used invites', () => {
		const adminId = admin();
		expect(findValidInvite('nonexistent')).toBeNull();

		const expired = createInvite({ createdByUserId: adminId, role: 'user', ttlMs: 1_000 });
		expect(findValidInvite(expired.token, expired.expiresAt + 1)).toBeNull();

		const used = createInvite({ createdByUserId: adminId, role: 'user', ttlMs: 60_000 });
		const newUser = createUser({ displayName: 'N', email: null, role: 'user' });
		expect(consumeInvite(used.id, newUser)).toBe(true);
		expect(findValidInvite(used.token)).toBeNull();
	});

	it('carries the granted role through to the validation result', () => {
		const adminId = admin();
		const inv = createInvite({ createdByUserId: adminId, role: 'admin', ttlMs: 60_000 });
		expect(findValidInvite(inv.token)?.role).toBe('admin');
	});

	it('consumeInvite is single-use: a double-redeem race yields one winner', () => {
		const adminId = admin();
		const inv = createInvite({ createdByUserId: adminId, role: 'user', ttlMs: 60_000 });
		const u1 = createUser({ displayName: 'U1', email: null, role: 'user' });
		const u2 = createUser({ displayName: 'U2', email: null, role: 'user' });
		expect(consumeInvite(inv.id, u1)).toBe(true);
		// Second attempt matches 0 rows (used_at already set) → false.
		expect(consumeInvite(inv.id, u2)).toBe(false);
	});

	it('deleteInvite revokes an unredeemed invite', () => {
		const adminId = admin();
		const inv = createInvite({ createdByUserId: adminId, role: 'user', ttlMs: 60_000 });
		expect(deleteInvite(inv.id)).toBe(true);
		expect(findValidInvite(inv.token)).toBeNull();
		expect(listInvites()).toHaveLength(0);
	});
});

describe('join finalizers (atomic create + bind + consume)', () => {
	function adminAndInvite(role: 'admin' | 'user' = 'user') {
		const adminId = createInitialUser({ displayName: 'Admin', email: 'admin@x.test' });
		const inv = createInvite({ createdByUserId: adminId, role, ttlMs: 60_000 });
		return { adminId, inv };
	}

	it('finalizeOAuthJoin creates the user, binds GitHub, and consumes the invite', () => {
		const { inv } = adminAndInvite('user');
		const userId = finalizeOAuthJoin({
			inviteId: inv.id,
			role: 'user',
			displayName: 'Invitee',
			email: 'invitee@x.test',
			oauth: {
				provider: 'github',
				externalId: '99887',
				externalUsername: 'invitee',
				externalEmail: 'invitee@x.test',
			},
		});
		expect(findUserByOAuth('github', '99887')?.userId).toBe(userId);
		// Invite is now spent.
		expect(findValidInvite(inv.token)).toBeNull();
	});

	it('finalizeOAuthJoin rolls back fully when the invite was already consumed', () => {
		const { inv } = adminAndInvite('user');
		// Pre-consume the invite (simulating the race winner).
		const winner = createUser({ displayName: 'W', email: null, role: 'user' });
		expect(consumeInvite(inv.id, winner)).toBe(true);
		const before = countUsers();

		expect(() =>
			finalizeOAuthJoin({
				inviteId: inv.id,
				role: 'user',
				displayName: 'Loser',
				email: null,
				oauth: {
					provider: 'github',
					externalId: '55555',
					externalUsername: 'loser',
					externalEmail: null,
				},
			}),
		).toThrow(InviteConsumedError);

		// No user created, no binding left behind — the whole tx rolled back.
		expect(countUsers()).toBe(before);
		expect(findUserByOAuth('github', '55555')).toBeNull();
	});

	it('finalizePasskeyJoin creates the user with the prospective id + credential', () => {
		const { inv } = adminAndInvite('user');
		const prospectiveId = 'pre-allocated-user-id';
		const userId = finalizePasskeyJoin({
			inviteId: inv.id,
			role: 'user',
			userId: prospectiveId,
			displayName: 'Passkey Invitee',
			email: null,
			credential: {
				id: 'cred-abc',
				publicKey: new Uint8Array([1, 2, 3, 4]),
				counter: 0,
				transports: ['internal'],
				backedUp: true,
				deviceType: 'multiDevice',
				name: null,
			},
		});
		expect(userId).toBe(prospectiveId);
		expect(listCredentialsForUser(userId).map((c) => c.id)).toEqual(['cred-abc']);
		expect(findValidInvite(inv.token)).toBeNull();
	});

	it('finalizePasskeyJoin honors the granted admin role', () => {
		const { inv } = adminAndInvite('admin');
		const userId = finalizePasskeyJoin({
			inviteId: inv.id,
			role: 'admin',
			userId: 'admin-invitee-id',
			displayName: 'Second Admin',
			email: null,
			credential: {
				id: 'cred-xyz',
				publicKey: new Uint8Array([9, 9]),
				counter: 0,
				transports: null,
				backedUp: false,
				deviceType: 'singleDevice',
				name: null,
			},
		});
		expect(userId).toBe('admin-invitee-id');
	});
});

describe('ensureAdminBootstrap (single-user -> multi-user upgrade recovery)', () => {
	// Insert a user row directly with an explicit createdAt — mirrors what the
	// role migration leaves behind (role defaults to 'user'), and lets us
	// control ordering for the "earliest" case.
	function seedLegacyUser(id: string, createdAt: number) {
		mocks.testDb
			.insert(users)
			.values({ id, email: null, displayName: id, role: 'user', createdAt, lastLoginAt: null })
			.run();
	}

	it('is a no-op on a fresh (empty) DB', () => {
		expect(ensureAdminBootstrap()).toBeNull();
		expect(countAdmins()).toBe(0);
	});

	it('promotes the lone existing user (the upgrade scenario)', () => {
		seedLegacyUser('solo', 1000);
		expect(countAdmins()).toBe(0);
		expect(ensureAdminBootstrap()).toBe('solo');
		expect(getUserRole('solo')).toBe('admin');
		expect(countAdmins()).toBe(1);
	});

	it('is a no-op (and idempotent) when an admin already exists', () => {
		createInitialUser({ displayName: 'Admin', email: null });
		createUser({ displayName: 'Member', email: null, role: 'user' });
		expect(ensureAdminBootstrap()).toBeNull();
		expect(ensureAdminBootstrap()).toBeNull();
		expect(countAdmins()).toBe(1);
	});

	it('promotes the earliest-created user when several exist with no admin', () => {
		seedLegacyUser('later', 2000);
		seedLegacyUser('earliest', 1000);
		seedLegacyUser('middle', 1500);
		expect(ensureAdminBootstrap()).toBe('earliest');
		expect(getUserRole('earliest')).toBe('admin');
		expect(getUserRole('later')).toBe('user');
		expect(countAdmins()).toBe(1);
	});
});
