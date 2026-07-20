/**
 * Last-method guard on DELETE /api/auth/passkey/:id. The guard must count the
 * user's ACTUAL remaining sign-in methods (other passkeys + OAuth bindings),
 * never a global feature flag — a passkey-only account (the normal result of
 * the passkey invite flow) must not be able to delete its sole credential and
 * lock itself out, regardless of GITHUB_LOGIN_ENABLED.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDb, closeTestDb, type TestDB } from './_helpers/test-db';
import { seedUser, seedOAuthAccount } from './_helpers/seed';

const mocks = vi.hoisted(() => ({
	testDb: null as unknown as TestDB,
	// Default: every provider enabled. Individual tests flip a provider off.
	providerEnabled: (_id: string) => true as boolean,
}));
vi.mock('$lib/server/db/client', () => ({
	getDb: () => mocks.testDb,
	closeDb: () => {},
}));
vi.mock('$lib/server/auth/oauth/registry', () => ({
	isProviderEnabled: (id: string) => mocks.providerEnabled(id),
}));

import { DELETE } from '../../src/routes/api/auth/passkey/[id]/+server';
import {
	insertCredential,
	countCredentialsForUser,
	type InsertPasskeyInput,
} from '$lib/server/db/queries/passkey';

beforeEach(() => {
	mocks.testDb = createTestDb();
	mocks.providerEnabled = () => true;
});
afterEach(() => {
	closeTestDb();
});

function addPasskey(userId: string, id: string): void {
	const input: InsertPasskeyInput = {
		id,
		userId,
		publicKey: new Uint8Array([1, 2, 3]),
		counter: 0,
		transports: ['internal'],
		name: id,
		backedUp: false,
		deviceType: 'singleDevice',
	};
	insertCredential(input);
}

function callDelete(userId: string, credId: string) {
	return (DELETE as unknown as (e: unknown) => Response | Promise<Response>)({
		locals: { user: { id: userId } },
		params: { id: credId },
	});
}

async function statusOf(fn: () => unknown): Promise<number> {
	try {
		await fn();
		return 200;
	} catch (e) {
		return (e as { status: number }).status;
	}
}

describe('DELETE /api/auth/passkey/:id — last-method guard', () => {
	it('refuses to delete a passkey-only account’s sole credential (409)', async () => {
		const u = seedUser();
		addPasskey(u.id, 'cred-1');

		expect(await statusOf(() => callDelete(u.id, 'cred-1'))).toBe(409);
		// Nothing was deleted.
		expect(countCredentialsForUser(u.id)).toBe(1);
	});

	it('allows deleting one of two passkeys (204)', async () => {
		const u = seedUser();
		addPasskey(u.id, 'cred-1');
		addPasskey(u.id, 'cred-2');

		const res = (await callDelete(u.id, 'cred-1')) as Response;
		expect(res.status).toBe(204);
		expect(countCredentialsForUser(u.id)).toBe(1);
	});

	it('allows deleting the last passkey when an OAuth binding remains (204)', async () => {
		const u = seedUser();
		addPasskey(u.id, 'cred-1');
		seedOAuthAccount(u.id, { provider: 'github' });

		const res = (await callDelete(u.id, 'cred-1')) as Response;
		expect(res.status).toBe(204);
		expect(countCredentialsForUser(u.id)).toBe(0);
	});

	it('refuses when the only OAuth binding is for a DISABLED provider', async () => {
		const u = seedUser();
		addPasskey(u.id, 'cred-1');
		seedOAuthAccount(u.id, { provider: 'github' });
		// GitHub login disabled → the github binding is not a usable fallback.
		mocks.providerEnabled = (id) => id !== 'github';

		expect(await statusOf(() => callDelete(u.id, 'cred-1'))).toBe(409);
		expect(countCredentialsForUser(u.id)).toBe(1);
	});

	it('returns 404 for a non-existent id even when it would be the last method', async () => {
		const u = seedUser();
		addPasskey(u.id, 'cred-1');

		expect(await statusOf(() => callDelete(u.id, 'does-not-exist'))).toBe(404);
		// The real credential is untouched.
		expect(countCredentialsForUser(u.id)).toBe(1);
	});
});
