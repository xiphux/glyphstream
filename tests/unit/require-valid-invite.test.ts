/**
 * The invite gate every join flow passes through, at start and again at
 * completion: a usable invite, or a 403.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb, closeTestDb } from './_helpers/test-db';
import { createInvite } from '#lib/server/db/queries/invites.js';
import { createInitialUser } from '#lib/server/db/queries/users.js';
import { requireValidInvite } from '#lib/server/auth/join.js';

let adminId: string;
beforeEach(() => {
	createTestDb();
	// Only an enabled admin's invites are valid.
	adminId = createInitialUser({ displayName: 'Admin', email: 'admin@x.test' });
});
afterEach(() => closeTestDb());

function status(fn: () => unknown): number | null {
	try {
		fn();
		return null;
	} catch (e) {
		return (e as { status?: number }).status ?? null;
	}
}

describe('requireValidInvite', () => {
	it('returns the invite and its token for a valid one', () => {
		const { token } = createInvite({ createdByUserId: adminId, role: 'user', ttlMs: 60_000 });
		const { inviteToken, invite } = requireValidInvite(token);
		expect(inviteToken).toBe(token);
		expect(invite.role).toBe('user');
	});

	it('refuses with 403 an unknown or expired token, or anything that is not a string', () => {
		const { token } = createInvite({ createdByUserId: adminId, role: 'user', ttlMs: -1 });
		expect(status(() => requireValidInvite(token))).toBe(403);
		expect(status(() => requireValidInvite('no-such-invite'))).toBe(403);
		expect(status(() => requireValidInvite(undefined))).toBe(403);
		expect(status(() => requireValidInvite({ token }))).toBe(403);
	});
});
