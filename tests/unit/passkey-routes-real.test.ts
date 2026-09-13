/**
 * The passkey options/verify routes against the REAL @simplewebauthn/server,
 * driven by a software authenticator that produces genuine signatures.
 *
 * passkey-helper.test.ts mocks the library, and the e2e ceremony
 * (passkey.spec.ts) proves only the happy path. The refusals are the security
 * surface — a wrong origin or RP, a stranger's signature, a missing UV flag, a
 * cloned counter, a disabled owner, a reused challenge — and each has to be
 * refused by the path that really runs in production: the library's checks
 * plus the route's own. @simplewebauthn/server is a major we take by hand, but
 * its minors auto-merge.
 */
import { eq } from 'drizzle-orm';
import type { Cookies, RequestEvent } from '@sveltejs/kit';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDb, closeTestDb, type TestDB } from './_helpers/test-db';
import { seedUser } from './_helpers/seed';
import { FLAGS, SoftAuthenticator } from './_helpers/soft-authenticator';

const ORIGIN = 'https://chat.example.test';
const RP_ID = 'chat.example.test';

const mocks = vi.hoisted(() => ({ testDb: null as unknown as TestDB, passkeysOn: true }));
vi.mock('$lib/server/db/client', () => ({ getDb: () => mocks.testDb, closeDb: () => {} }));
vi.mock('$lib/server/env', async (importOriginal) => ({
	...(await importOriginal<typeof import('$lib/server/env')>()),
	publicBaseUrl: () => 'https://chat.example.test',
	passkeyLoginEnabled: () => mocks.passkeysOn,
}));

import { POST as loginOptions } from '../../src/routes/api/auth/passkey/login/options/+server';
import { POST as loginVerify } from '../../src/routes/api/auth/passkey/login/verify/+server';
import { POST as registerOptions } from '../../src/routes/api/auth/passkey/register/options/+server';
import { POST as registerVerify } from '../../src/routes/api/auth/passkey/register/verify/+server';
import { resetRpCache } from '$lib/server/auth/passkey';
import { createSession, validateSessionToken } from '$lib/server/auth/session';
import { findCredentialById, insertCredential } from '$lib/server/db/queries/passkey';
import { passkeyCredentials, sessions, users } from '$lib/server/db/schema';

/** A browser's cookie jar, shared across the options → verify round trip. */
function browserJar() {
	const jar = new Map<string, string>();
	const cookies = {
		get: (n: string) => jar.get(n),
		getAll: () => [...jar].map(([name, value]) => ({ name, value })),
		set: (n: string, v: string) => void jar.set(n, v),
		delete: (n: string) => void jar.delete(n),
		serialize: () => '',
	} as unknown as Cookies;
	return { jar, cookies };
}

type Handler = (event: RequestEvent) => Promise<Response> | Response;

async function invoke(
	handler: Handler,
	opts: { cookies: Cookies; body?: unknown; user?: App.Locals['user'] },
): Promise<{ status: number; json: unknown }> {
	const url = new URL('/api/auth/passkey/x', ORIGIN);
	const event = {
		url,
		cookies: opts.cookies,
		locals: { user: opts.user ?? null, sessionId: null } as App.Locals,
		request: new Request(url, {
			method: 'POST',
			headers: { 'content-type': 'application/json', 'user-agent': 'vitest' },
			body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
		}),
	} as unknown as RequestEvent;
	try {
		const res = await handler(event);
		return { status: res.status, json: await res.json() };
	} catch (e) {
		if (e && typeof e === 'object' && 'status' in e) {
			return { status: Number(e.status), json: (e as { body?: unknown }).body };
		}
		throw e;
	}
}

function signedInUser(userId: string): NonNullable<App.Locals['user']> {
	return validateSessionToken(createSession(userId).token)!.user;
}

function storeCredential(auth: SoftAuthenticator, userId: string, counter = 0) {
	insertCredential({
		id: auth.id,
		userId,
		publicKey: auth.cosePublicKey(),
		counter,
		transports: ['internal'],
		backedUp: false,
		deviceType: 'singleDevice',
		name: 'test key',
	});
}

/** Run login/options in `jar`, then login/verify with the assertion `build` makes. */
async function login(
	build: (challenge: string) => unknown,
	jar = browserJar(),
): Promise<{ status: number; json: unknown; jar: ReturnType<typeof browserJar> }> {
	const opts = await invoke(loginOptions as Handler, { cookies: jar.cookies });
	const { challenge } = opts.json as { challenge: string };
	const res = await invoke(loginVerify as Handler, {
		cookies: jar.cookies,
		body: { response: build(challenge) },
	});
	return { ...res, jar };
}

const sessionCount = () => mocks.testDb.select().from(sessions).all().length;

beforeEach(() => {
	mocks.testDb = createTestDb();
	mocks.passkeysOn = true;
	resetRpCache();
	vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
	closeTestDb();
	vi.restoreAllMocks();
});

describe('registration', () => {
	it('verifies a real attestation and stores the COSE public key', async () => {
		const u = seedUser();
		const user = signedInUser(u.id);
		const auth = new SoftAuthenticator(RP_ID, ORIGIN);
		const { cookies, jar } = browserJar();

		const opts = await invoke(registerOptions as Handler, { cookies, user });
		expect(opts.status).toBe(200);
		const { challenge, rp, authenticatorSelection } = opts.json as {
			challenge: string;
			rp: { id: string };
			authenticatorSelection: { userVerification: string };
		};
		expect(rp.id).toBe(RP_ID);
		expect(authenticatorSelection.userVerification).toBe('required');

		const res = await invoke(registerVerify as Handler, {
			cookies,
			user,
			body: { response: auth.register(challenge), name: `  ${'n'.repeat(80)}  ` },
		});
		expect(res.status).toBe(201);
		expect(res.json).toMatchObject({ id: auth.id, name: 'n'.repeat(60) });

		const row = findCredentialById(auth.id)!;
		expect(row.userId).toBe(u.id);
		expect(Buffer.from(row.publicKey).equals(auth.cosePublicKey())).toBe(true);
		expect(row.transports).toEqual(['internal']);
		// Single-use challenge: consumed by verify.
		expect([...jar.keys()].some((k) => k.includes('reg_challenge'))).toBe(false);
	});

	it.each([
		['a foreign origin', { origin: 'https://evil.example' }],
		['another RP ID', { rpId: 'evil.example' }],
		['no user verification', { flags: FLAGS.UP | FLAGS.AT }],
	])('refuses an attestation with %s, storing nothing', async (_label, override) => {
		const user = signedInUser(seedUser().id);
		const auth = new SoftAuthenticator(RP_ID, ORIGIN);
		const { cookies } = browserJar();
		const { challenge } = (await invoke(registerOptions as Handler, { cookies, user })).json as {
			challenge: string;
		};
		const res = await invoke(registerVerify as Handler, {
			cookies,
			user,
			body: { response: auth.register(challenge, override) },
		});
		expect(res.status).toBe(400);
		expect(findCredentialById(auth.id)).toBeNull();
	});

	it('refuses a response signed over a different challenge', async () => {
		const user = signedInUser(seedUser().id);
		const auth = new SoftAuthenticator(RP_ID, ORIGIN);
		const { cookies } = browserJar();
		await invoke(registerOptions as Handler, { cookies, user });
		const res = await invoke(registerVerify as Handler, {
			cookies,
			user,
			body: { response: auth.register('bm90LXRoZS1jaGFsbGVuZ2U') },
		});
		expect(res.status).toBe(400);
	});

	it('requires a signed-in user', async () => {
		const { cookies } = browserJar();
		expect((await invoke(registerOptions as Handler, { cookies })).status).toBe(401);
		expect((await invoke(registerVerify as Handler, { cookies, body: {} })).status).toBe(401);
	});

	it('returns 409 for a credential id that is already registered', async () => {
		const owner = seedUser();
		const user = signedInUser(seedUser().id);
		const auth = new SoftAuthenticator(RP_ID, ORIGIN);
		storeCredential(auth, owner.id);
		const { cookies } = browserJar();
		const { challenge } = (await invoke(registerOptions as Handler, { cookies, user })).json as {
			challenge: string;
		};
		const res = await invoke(registerVerify as Handler, {
			cookies,
			user,
			body: { response: auth.register(challenge) },
		});
		expect(res.status).toBe(409);
		expect(findCredentialById(auth.id)!.userId).toBe(owner.id);
	});
});

describe('login', () => {
	let userId: string;
	let auth: SoftAuthenticator;

	beforeEach(() => {
		userId = seedUser().id;
		auth = new SoftAuthenticator(RP_ID, ORIGIN);
	});

	it('verifies a real assertion, bumps the counter, and starts a session', async () => {
		storeCredential(auth, userId, 5);
		const { status, jar } = await login((c) => auth.assert(c, userId, { counter: 6 }));
		expect(status).toBe(200);
		expect(findCredentialById(auth.id)!.counter).toBe(6);
		const token = jar.jar.get('glyphstream_session');
		expect(token).toBeTruthy();
		expect(validateSessionToken(token!)!.user.id).toBe(userId);
		expect([...jar.jar.keys()].some((k) => k.includes('login_challenge'))).toBe(false);
	});

	it('accepts an always-zero counter (iCloud Keychain) on every login', async () => {
		storeCredential(auth, userId, 0);
		expect((await login((c) => auth.assert(c, userId, { counter: 0 }))).status).toBe(200);
		expect((await login((c) => auth.assert(c, userId, { counter: 0 }))).status).toBe(200);
	});

	it.each([
		['a foreign origin', { origin: 'https://evil.example' }],
		['another RP ID', { rpId: 'evil.example' }],
		['no user verification', { flags: FLAGS.UP }],
		['a stranger’s signature', { signingKey: SoftAuthenticator.strangerKey() }],
	])('refuses an assertion with %s', async (_label, override) => {
		storeCredential(auth, userId);
		const { status } = await login((c) => auth.assert(c, userId, override));
		expect(status).toBe(401);
		expect(sessionCount()).toBe(0);
	});

	it('refuses an assertion signed over a different challenge', async () => {
		storeCredential(auth, userId);
		const { status } = await login(() => auth.assert('bm90LXRoZS1jaGFsbGVuZ2U', userId));
		expect(status).toBe(401);
	});

	// Enforced twice — by the library and again by the route — so removing
	// either alone still passes; this pins the behavior, not one copy of it.
	it('refuses a counter that did not advance (possible clone) without updating it', async () => {
		storeCredential(auth, userId, 10);
		const { status } = await login((c) => auth.assert(c, userId, { counter: 10 }));
		expect(status).toBe(401);
		expect(findCredentialById(auth.id)!.counter).toBe(10);
		expect(sessionCount()).toBe(0);
	});

	it('refuses a userHandle that names a different user', async () => {
		storeCredential(auth, userId);
		const other = seedUser().id;
		const { status } = await login((c) =>
			auth.assert(c, userId, { userHandle: Buffer.from(other).toString('base64url') }),
		);
		expect(status).toBe(401);
	});

	it('refuses a disabled owner with 403 and no session', async () => {
		storeCredential(auth, userId);
		mocks.testDb.update(users).set({ disabledAt: Date.now() }).where(eq(users.id, userId)).run();
		const { status } = await login((c) => auth.assert(c, userId));
		expect(status).toBe(403);
		expect(sessionCount()).toBe(0);
	});

	it('refuses an unknown credential', async () => {
		const { status } = await login((c) => auth.assert(c, userId));
		expect(status).toBe(401);
	});

	it('clears the challenge cookie: replaying from the same browser fails', async () => {
		// Counter 0 (iCloud-style), so the clone guard can't be what stops the
		// replay. What this proves is that verify clears the challenge cookie, so a
		// browser resending the same request has no challenge left. The challenge
		// is not tracked server-side: a replay that also resends the captured
		// cookie within its TTL is not covered here.
		storeCredential(auth, userId, 0);
		let assertion: unknown;
		const first = await login((c) => (assertion = auth.assert(c, userId, { counter: 0 })));
		expect(first.status).toBe(200);
		// The identical request again, from the same browser, no new options call.
		const replay = await invoke(loginVerify as Handler, {
			cookies: first.jar.cookies,
			body: { response: assertion },
		});
		expect(replay.status).toBe(400);
		expect(sessionCount()).toBe(1);
	});

	it('is closed entirely when passkey login is disabled', async () => {
		storeCredential(auth, userId);
		mocks.passkeysOn = false;
		const { cookies } = browserJar();
		expect((await invoke(loginOptions as Handler, { cookies })).status).toBe(403);
		expect((await invoke(loginVerify as Handler, { cookies, body: {} })).status).toBe(403);
		expect(mocks.testDb.select().from(passkeyCredentials).all()).toHaveLength(1);
	});
});
