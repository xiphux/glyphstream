/**
 * A passkey assertion carries its challenge inside clientDataJSON, so a
 * captured verify request is everything a replay needs — unless the server
 * binds the challenge: signed with its ceremony and an expiry, and accepted
 * once. With a synced passkey the signature counter stays 0, so nothing else
 * would catch the replay.
 */
import type { Cookies, RequestEvent } from '@sveltejs/kit';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestDb, closeTestDb, type TestDB } from './_helpers/test-db';
import { seedUser } from './_helpers/seed';
import { SoftAuthenticator } from './_helpers/soft-authenticator';

const ORIGIN = 'https://chat.example.test';
const RP_ID = 'chat.example.test';
const LOGIN = 'glyphstream_passkey_login_challenge';
const UNLOCK = 'glyphstream_passkey_unlock_challenge';

const mocks = vi.hoisted(() => ({ testDb: null as unknown as TestDB }));
vi.mock('#lib/server/env.js', async (importOriginal) => ({
	...(await importOriginal<typeof import('#lib/server/env.js')>()),
	publicBaseUrl: () => 'https://chat.example.test',
	passkeyLoginEnabled: () => true,
	authSecret: () => 'test-secret-do-not-use-in-prod',
}));

import { POST as loginOptions } from '../../src/routes/api/auth/passkey/login/options/+server';
import { POST as loginVerify } from '../../src/routes/api/auth/passkey/login/verify/+server';
import { POST as unlockOptions } from '../../src/routes/api/auth/unlock/options/+server';
import { POST as unlockVerify } from '../../src/routes/api/auth/unlock/verify/+server';
import { insertCredential } from '#lib/server/db/queries/passkey.js';
import { sessions } from '#lib/server/db/schema.js';
import { createSession, validateSessionToken } from '#lib/server/auth/session.js';
import { resetConfigCachesForTests } from '#lib/server/util/config-cache.js';

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
type Locals = Record<string, unknown>;
const anonymous: Locals = { user: null, sessionId: null };

async function call(
	handler: Handler,
	cookies: Cookies,
	body?: unknown,
	locals: Locals = anonymous,
): Promise<{ status: number; json?: unknown }> {
	const url = new URL('/api/auth/x', ORIGIN);
	const event = {
		url,
		cookies,
		locals,
		request: new Request(url, {
			method: 'POST',
			headers: { 'content-type': 'application/json', 'user-agent': 'vitest' },
			body: body === undefined ? undefined : JSON.stringify(body),
		}),
	} as unknown as RequestEvent;
	try {
		const res = await handler(event);
		const json: unknown = res.headers.get('content-type')?.includes('json')
			? await res.json()
			: undefined;
		return { status: res.status, json };
	} catch (e) {
		if (e && typeof e === 'object' && 'status' in e) return { status: Number(e.status) };
		throw e;
	}
}

/** Run an options endpoint and return the challenge the browser signs. */
async function issueChallenge(handler: Handler, cookies: Cookies, locals?: Locals) {
	const res = await call(handler, cookies, undefined, locals);
	expect(res.status).toBe(200);
	return (res.json as { challenge: string }).challenge;
}

const sessionCount = () => mocks.testDb.select().from(sessions).all().length;

let auth: SoftAuthenticator;
let userId: string;

beforeEach(() => {
	mocks.testDb = createTestDb();
	resetConfigCachesForTests();
	vi.spyOn(console, 'warn').mockImplementation(() => {});
	userId = seedUser().id;
	auth = new SoftAuthenticator(RP_ID, ORIGIN);
	// Counter 0: a synced (iCloud / Google Password Manager) passkey.
	insertCredential({
		id: auth.id,
		userId,
		publicKey: auth.cosePublicKey(),
		counter: 0,
		transports: ['internal'],
		backedUp: true,
		deviceType: 'multiDevice',
		name: 'synced key',
	});
});

afterEach(() => {
	closeTestDb();
	vi.restoreAllMocks();
});

function lockedSession() {
	const sessionId = validateSessionToken(createSession(userId).token)!.sessionId;
	const appLock = { locked: true, sliding: true, userId, sessionId, timeoutMs: 60_000 };
	return { sessionId, locals: { ...anonymous, appLock } };
}

describe('passkey login challenge', () => {
	it('refuses a whole captured request, cookie included, sent a second time', async () => {
		const victim = browserJar();
		const challenge = await issueChallenge(loginOptions as Handler, victim.cookies);
		const cookie = victim.jar.get(LOGIN)!;
		const assertion = auth.assert(challenge, userId, { counter: 0 });
		expect(
			(await call(loginVerify as Handler, victim.cookies, { response: assertion })).status,
		).toBe(200);

		const attacker = browserJar();
		attacker.jar.set(LOGIN, cookie);
		const replay = await call(loginVerify as Handler, attacker.cookies, { response: assertion });
		expect(replay.status).toBeGreaterThanOrEqual(400);
		expect(sessionCount()).toBe(1);
	});

	it('refuses the request body alone, with the challenge planted as the cookie', async () => {
		const victim = browserJar();
		const challenge = await issueChallenge(loginOptions as Handler, victim.cookies);
		const assertion = auth.assert(challenge, userId, { counter: 0 });
		expect(
			(await call(loginVerify as Handler, victim.cookies, { response: assertion })).status,
		).toBe(200);

		const attacker = browserJar();
		attacker.jar.set(LOGIN, challenge);
		const replay = await call(loginVerify as Handler, attacker.cookies, { response: assertion });
		expect(replay.status).toBeGreaterThanOrEqual(400);
		expect(sessionCount()).toBe(1);
	});

	it('refuses a challenge the server never issued', async () => {
		const selfIssued = Buffer.from('attacker-chosen-challenge-0123456789').toString('base64url');
		const jar = browserJar();
		jar.jar.set(LOGIN, selfIssued);
		const res = await call(loginVerify as Handler, jar.cookies, {
			response: auth.assert(selfIssued, userId, { counter: 0 }),
		});
		expect(res.status).toBeGreaterThanOrEqual(400);
		expect(sessionCount()).toBe(0);
	});

	it('refuses an expired challenge', async () => {
		vi.useFakeTimers({ toFake: ['Date'] });
		try {
			const jar = browserJar();
			const challenge = await issueChallenge(loginOptions as Handler, jar.cookies);
			vi.setSystemTime(Date.now() + 301_000);
			const res = await call(loginVerify as Handler, jar.cookies, {
				response: auth.assert(challenge, userId, { counter: 0 }),
			});
			expect(res.status).toBeGreaterThanOrEqual(400);
			expect(sessionCount()).toBe(0);
		} finally {
			vi.useRealTimers();
		}
	});

	it('refuses an assertion made for an app-lock unlock', async () => {
		const { locals } = lockedSession();
		const victim = browserJar();
		const challenge = await issueChallenge(unlockOptions as Handler, victim.cookies, locals);
		const unlockCookie = victim.jar.get(UNLOCK)!;
		const assertion = auth.assert(challenge, userId, { counter: 0 });
		expect(
			(await call(unlockVerify as Handler, victim.cookies, { response: assertion }, locals)).status,
		).toBe(200);
		const before = sessionCount();

		for (const planted of [challenge, unlockCookie]) {
			const attacker = browserJar();
			attacker.jar.set(LOGIN, planted);
			const replay = await call(loginVerify as Handler, attacker.cookies, { response: assertion });
			expect(replay.status).toBeGreaterThanOrEqual(400);
		}
		expect(sessionCount()).toBe(before);
	});
});

describe('passkey unlock challenge', () => {
	it('a replayed unlock does not re-open a session that locked again', async () => {
		const { sessionId, locals } = lockedSession();
		const victim = browserJar();
		const challenge = await issueChallenge(unlockOptions as Handler, victim.cookies, locals);
		const cookie = victim.jar.get(UNLOCK)!;
		const assertion = auth.assert(challenge, userId, { counter: 0 });
		expect(
			(await call(unlockVerify as Handler, victim.cookies, { response: assertion }, locals)).status,
		).toBe(200);

		mocks.testDb.update(sessions).set({ unlockedUntil: 1 }).where(eq(sessions.id, sessionId)).run();
		for (const planted of [challenge, cookie]) {
			const again = browserJar();
			again.jar.set(UNLOCK, planted);
			const replay = await call(
				unlockVerify as Handler,
				again.cookies,
				{ response: assertion },
				locals,
			);
			expect(replay.status).toBeGreaterThanOrEqual(400);
		}
		const row = mocks.testDb.select().from(sessions).where(eq(sessions.id, sessionId)).get()!;
		expect(row.unlockedUntil).toBe(1);
	});
});
