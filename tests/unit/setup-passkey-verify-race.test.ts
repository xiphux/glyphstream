/**
 * First-run passkey setup: the gate is checked before the registration
 * ceremony's await, so a parallel setup (another tab, the OAuth path)
 * finishing in that window reaches createInitialUser with setup already
 * closed. The loser must get the gate's own 409, not a 500.
 */
import type { Cookies } from '@sveltejs/kit';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDb, closeTestDb, type TestDB } from './_helpers/test-db';
import { seedUser } from './_helpers/seed';

const mocks = vi.hoisted(() => ({
	testDb: null as unknown as TestDB,
	duringCeremony: null as (() => void) | null,
}));

vi.mock('#lib/server/env.js', async (importOriginal) => ({
	...(await importOriginal<typeof import('#lib/server/env.js')>()),
	authSecret: () => 'test-secret-do-not-use-in-prod',
	cookiesSecure: () => false,
	passkeyLoginEnabled: () => true,
	setupToken: () => 'tok',
}));
vi.mock('#lib/server/auth/passkey.js', () => ({
	verifyRegistrationCeremony: () => {
		mocks.duringCeremony?.();
		return Promise.resolve({
			credential: { id: 'cred-1', publicKey: new Uint8Array([1]), counter: 0 },
			backedUp: false,
			deviceType: 'singleDevice',
			transports: [],
		});
	},
}));

import { POST } from '../../src/routes/api/auth/setup/passkey/verify/+server';
import { SETUP_PASSKEY_CARRY_COOKIE } from '#lib/server/auth/setup.js';
import { sign } from '#lib/server/auth/signed-cookies.js';
import { countUsers } from '#lib/server/db/queries/users.js';

function event() {
	const store = new Map([
		[
			SETUP_PASSKEY_CARRY_COOKIE,
			sign({ userId: 'u-new', displayName: 'Operator', email: null }, 600_000),
		],
	]);
	const cookies = {
		get: (n: string) => store.get(n),
		set: (n: string, v: string) => void store.set(n, v),
		delete: (n: string) => void store.delete(n),
	} as unknown as Cookies;
	const url = new URL('http://localhost/api/auth/setup/passkey/verify?token=tok');
	return {
		url,
		cookies,
		request: new Request(url, { method: 'POST', body: '{}' }),
	} as unknown as Parameters<typeof POST>[0];
}

beforeEach(() => {
	mocks.testDb = createTestDb();
	mocks.duringCeremony = null;
});
afterEach(() => {
	closeTestDb();
});

describe('POST /api/auth/setup/passkey/verify', () => {
	it('creates the operator when setup is still open', async () => {
		const res = (await POST(event())) as Response;
		expect(res.status).toBe(200);
		expect(countUsers()).toBe(1);
	});

	it('answers 409 when a parallel setup finished during the ceremony', async () => {
		mocks.duringCeremony = () => seedUser();
		await expect(POST(event())).rejects.toMatchObject({
			status: 409,
			body: { message: 'Setup is already complete' },
		});
		expect(countUsers()).toBe(1);
	});
});
