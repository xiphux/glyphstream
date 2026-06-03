/**
 * Route-handler tests for DELETE /api/auth/oauth/:provider — the
 * server-side last-method guard refusing 409 when the unlink would
 * leave the user with no viable sign-in method. The settings page's
 * component test covers the UI hiding the button; this covers the
 * authoritative server-side enforcement, which is what someone
 * `curl`-ing the API would hit.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isHttpError, type HttpError } from '@sveltejs/kit';
import { createTestDb, closeTestDb, type TestDB } from './_helpers/test-db';
import { seedOAuthAccount, seedUser } from './_helpers/seed';

const mocks = vi.hoisted(() => ({ testDb: null as unknown as TestDB }));
vi.mock('$lib/server/db/client', () => ({
	getDb: () => mocks.testDb,
	closeDb: () => {},
}));

import { DELETE } from '../../src/routes/api/auth/oauth/[provider]/+server';
import { insertCredential } from '$lib/server/db/queries/passkey';
import { listOAuthAccountsForUser } from '$lib/server/db/queries/oauth-accounts';

interface Event {
	locals: { user: { id: string; displayName: string | null; email: string | null } | null };
	params: { provider: string };
}

function mkEvent(over: Partial<Event> = {}): Event {
	return {
		locals: over.locals ?? { user: null },
		params: over.params ?? { provider: 'github' },
	};
}

function userLocals(id: string): Event['locals'] {
	return { user: { id, displayName: null, email: null } };
}

function seedPasskey(userId: string, id: string): void {
	insertCredential({
		id,
		userId,
		publicKey: new Uint8Array([1, 2, 3]),
		counter: 0,
		transports: null,
		backedUp: true,
		deviceType: 'multiDevice',
		name: null,
	});
}

/**
 * The DELETE handler is synchronous — its `throw error(...)` escapes
 * before any promise wraps it, so a plain `Promise.resolve(DELETE(…))`
 * loses the throw. Run the handler inside an async IIFE so the throw
 * becomes a rejected promise we can await.
 */
async function expectHttpError(fn: () => unknown): Promise<HttpError> {
	try {
		await (async () => fn())();
		throw new Error('expected HttpError, none thrown');
	} catch (e) {
		if (isHttpError(e)) return e;
		throw e;
	}
}

beforeEach(() => {
	mocks.testDb = createTestDb();
});

afterEach(() => {
	closeTestDb();
});

describe('DELETE /api/auth/oauth/:provider — auth', () => {
	it('throws 401 when not signed in', async () => {
		const event = mkEvent({ locals: { user: null } });
		const err = await expectHttpError(() => DELETE(event as never));
		expect(err.status).toBe(401);
	});
});

describe('DELETE /api/auth/oauth/:provider — last-method guard', () => {
	it('refuses with 409 when user has only this provider + zero passkeys', async () => {
		const u = seedUser();
		seedOAuthAccount(u.id, { provider: 'github', externalId: '42' });

		const event = mkEvent({ locals: userLocals(u.id), params: { provider: 'github' } });
		const err = await expectHttpError(() => DELETE(event as never));
		expect(err.status).toBe(409);
		// Row stays put — the guard fires before the delete.
		expect(listOAuthAccountsForUser(u.id)).toHaveLength(1);
	});

	it('allows the unlink when at least one passkey remains', async () => {
		const u = seedUser();
		seedOAuthAccount(u.id, { provider: 'github', externalId: '42' });
		seedPasskey(u.id, 'cred-1');

		const event = mkEvent({ locals: userLocals(u.id), params: { provider: 'github' } });
		const res = (await DELETE(event as never)) as Response;
		expect(res.status).toBe(204);
		expect(listOAuthAccountsForUser(u.id)).toHaveLength(0);
	});

	it('allows the unlink when another OAuth provider remains', async () => {
		const u = seedUser();
		seedOAuthAccount(u.id, { provider: 'github', externalId: '42' });
		seedOAuthAccount(u.id, { provider: 'google', externalId: 'g-42' });

		const event = mkEvent({ locals: userLocals(u.id), params: { provider: 'github' } });
		const res = (await DELETE(event as never)) as Response;
		expect(res.status).toBe(204);

		// Only the targeted binding is gone.
		const remaining = listOAuthAccountsForUser(u.id);
		expect(remaining.map((r) => r.provider)).toEqual(['google']);
	});
});

describe('DELETE /api/auth/oauth/:provider — 404 paths', () => {
	it('throws 404 when the provider isn’t bound (and another viable method exists)', async () => {
		const u = seedUser();
		seedOAuthAccount(u.id, { provider: 'github', externalId: '42' });
		seedPasskey(u.id, 'cred-1');

		const event = mkEvent({ locals: userLocals(u.id), params: { provider: 'google' } });
		const err = await expectHttpError(() => DELETE(event as never));
		expect(err.status).toBe(404);
	});

	it('isolates by user — a different user’s binding doesn’t satisfy the unlink', async () => {
		const u1 = seedUser();
		const u2 = seedUser();
		seedOAuthAccount(u1.id, { provider: 'github', externalId: 'u1' });
		// u2 has a passkey + their own github binding via the seeded helper
		// would conflict on UNIQUE — so just give them a passkey.
		seedPasskey(u2.id, 'u2-cred');

		// u2 tries to unlink github — not bound on their row → 404.
		const event = mkEvent({ locals: userLocals(u2.id), params: { provider: 'github' } });
		const err = await expectHttpError(() => DELETE(event as never));
		expect(err.status).toBe(404);
		// u1's binding untouched.
		expect(listOAuthAccountsForUser(u1.id)).toHaveLength(1);
	});
});
