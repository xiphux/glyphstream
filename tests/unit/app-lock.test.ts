/**
 * App lock (server/auth/app-lock.ts) — an installed-app session that has sat
 * unused past the user's window needs a passkey before it's usable again.
 *
 * Security-critical in both directions: a decision that says "unlocked" too
 * readily makes the setting decorative, and one that locks without a way back
 * (last passkey deleted, no admin override) strands an account.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Cookies } from '@sveltejs/kit';
import { eq } from 'drizzle-orm';
import { createTestDb, closeTestDb, type TestDB } from './_helpers/test-db';
import { seedUser } from './_helpers/seed';

const mocks = vi.hoisted(() => ({
	testDb: null as unknown as TestDB,
	sendCalls: [] as string[],
	/** Which credential the (mocked) signature check saw, if it ran. */
	verified: [] as string[],
	passkeysEnabled: true,
}));
vi.mock('$lib/server/env', async (importOriginal) => ({
	...(await importOriginal<typeof import('$lib/server/env')>()),
	passkeyLoginEnabled: () => mocks.passkeysEnabled,
}));
vi.mock('$lib/server/db/client', () => ({ getDb: () => mocks.testDb, closeDb: () => {} }));
vi.mock('$lib/server/push/web-push', () => ({
	sendPushNotification: vi.fn(async (_sub: unknown, payload: string) => {
		mocks.sendCalls.push(payload);
		return { ok: true };
	}),
}));
// The WebAuthn signature itself is covered by the passkey tests; here the
// question is what the app-lock layer does AROUND it — which credential it
// accepts, and what it writes afterwards.
vi.mock('$lib/server/auth/passkey', async (importOriginal) => ({
	...(await importOriginal<typeof import('$lib/server/auth/passkey')>()),
	verifyStoredCredentialAssertion: vi.fn(async (_r: unknown, _c: string, cred: { id: string }) => {
		mocks.verified.push(cred.id);
	}),
}));

import {
	clearAppLock,
	evaluateAppLock,
	getAppLockTimeout,
	initialUnlockedUntil,
	setAppLockTimeout,
} from '$lib/server/auth/app-lock';
import { redirectUnauthenticatedPage, requireUser } from '$lib/server/auth/guard';
import { createSession, validateSessionToken } from '$lib/server/auth/session';
import { insertCredential } from '$lib/server/db/queries/passkey';
import { upsertPushSubscription } from '$lib/server/db/queries/push-subscriptions';
import { setUserPreferences } from '$lib/server/db/queries/user-preferences';
import { sessions } from '$lib/server/db/schema';
import { notifyConversationComplete } from '$lib/server/push/notify';
import { GENERIC_TITLE } from '$lib/sw/notification-copy';
import { safeUnlockReturn } from '$lib/app-lock';
import { PUT as putAppLock } from '../../src/routes/api/auth/app-lock/+server';
import { POST as unlockVerify } from '../../src/routes/api/auth/unlock/verify/+server';
import { DELETE as deletePasskey } from '../../src/routes/api/auth/passkey/[id]/+server';
import { PATCH as adminPatch } from '../../src/routes/api/admin/users/[id]/+server';

const MIN = 60_000;

beforeEach(() => {
	mocks.testDb = createTestDb();
	mocks.sendCalls = [];
	mocks.verified = [];
	mocks.passkeysEnabled = true;
});
afterEach(() => closeTestDb());

function fakeCookies(initial: Record<string, string> = {}): Cookies {
	const jar = new Map(Object.entries(initial));
	return {
		get: (n: string) => jar.get(n),
		getAll: () => [...jar].map(([name, value]) => ({ name, value })),
		set: (n: string, v: string) => void jar.set(n, v),
		delete: (n: string) => void jar.delete(n),
		serialize: () => '',
	} as unknown as Cookies;
}

function addPasskey(userId: string, id: string) {
	insertCredential({
		id,
		userId,
		publicKey: new Uint8Array([1, 2, 3]),
		counter: 0,
		transports: ['internal'],
		name: id,
		backedUp: true,
		deviceType: 'multiDevice',
	});
}

function jsonRequest(body: unknown): Request {
	return new Request('http://x.test/', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify(body),
	});
}

async function statusOf(fn: () => unknown): Promise<number> {
	try {
		const res = await fn();
		return res instanceof Response ? res.status : 200;
	} catch (e) {
		return (e as { status: number }).status;
	}
}

function unlockedUntilOf(sessionId: string): number | null {
	return mocks.testDb.select().from(sessions).where(eq(sessions.id, sessionId)).get()!
		.unlockedUntil;
}

describe('evaluateAppLock', () => {
	const base = {
		timeoutMs: 5 * MIN,
		unlockedUntil: 1_000_000 + 5 * MIN,
		installedApp: true,
		passkeysEnabled: true,
		now: 1_000_000,
	};

	it('is inert when the lock is off, or passkeys are disabled instance-wide', () => {
		expect(evaluateAppLock({ ...base, timeoutMs: null, unlockedUntil: 0 })).toEqual({
			locked: false,
			sliding: false,
			extendTo: null,
		});
		expect(evaluateAppLock({ ...base, passkeysEnabled: false, unlockedUntil: 0 }).locked).toBe(
			false,
		);
	});

	it('locks the installed app once the window has lapsed, and not before', () => {
		expect(evaluateAppLock({ ...base, unlockedUntil: base.now }).locked).toBe(true);
		expect(evaluateAppLock({ ...base, unlockedUntil: base.now + 1 }).locked).toBe(false);
	});

	it('treats a never-unlocked installed-app session (NULL) as locked', () => {
		expect(evaluateAppLock({ ...base, unlockedUntil: null }).locked).toBe(true);
	});

	it('leaves the ordinary browser alone — unless the session was born locked', () => {
		expect(evaluateAppLock({ ...base, installedApp: false, unlockedUntil: null }).locked).toBe(
			false,
		);
		expect(evaluateAppLock({ ...base, installedApp: false, unlockedUntil: 5 }).locked).toBe(false);
		expect(evaluateAppLock({ ...base, installedApp: false, unlockedUntil: 0 }).locked).toBe(true);
	});

	it('slides the window forward on a throttle, not on every request', () => {
		// Fresh window: no write.
		expect(evaluateAppLock(base).extendTo).toBeNull();
		// Decayed past the throttle (a quarter of the timeout, capped at 30s).
		expect(evaluateAppLock({ ...base, unlockedUntil: base.now + 4 * MIN }).extendTo).toBe(
			base.now + 5 * MIN,
		);
	});

	it('pulls an over-long window in, so shortening the setting applies immediately', () => {
		expect(evaluateAppLock({ ...base, unlockedUntil: base.now + 60 * MIN }).extendTo).toBe(
			base.now + 5 * MIN,
		);
	});

	it('keeps a one-minute window alive across the client keep-alive interval', () => {
		// Worst case: the last write happened just under the throttle ago, then
		// a full keep-alive interval passes before the next request.
		const timeoutMs = MIN;
		const throttle = timeoutMs / 4;
		const lastWrite = base.now - throttle + 1;
		const next = evaluateAppLock({
			...base,
			timeoutMs,
			unlockedUntil: lastWrite + timeoutMs,
			now: lastWrite + throttle - 1 + 20_000,
		});
		expect(next.locked).toBe(false);
	});
});

describe('session lifecycle', () => {
	it('an OAuth sign-in for a lock-enabled user is born locked; a passkey one is not', () => {
		expect(initialUnlockedUntil(5 * MIN, 'oauth', 1000)).toBe(0);
		expect(initialUnlockedUntil(5 * MIN, 'passkey', 1000)).toBe(1000 + 5 * MIN);
		expect(initialUnlockedUntil(null, 'oauth', 1000)).toBeNull();
	});

	it('validateSessionToken surfaces the lock inputs', () => {
		const u = seedUser();
		setAppLockTimeout(u.id, 15 * MIN);
		const { token } = createSession(u.id, null, 0);
		expect(validateSessionToken(token)!.appLock).toEqual({ timeoutMs: 15 * MIN, unlockedUntil: 0 });
	});
});

describe('turning the lock off', () => {
	it('retires born-locked markers, so turning it back on does not lock them everywhere', () => {
		const u = seedUser();
		setAppLockTimeout(u.id, MIN);
		const { token: oauth } = createSession(u.id, null, 0);
		const { token: other } = createSession(u.id, null, 12345);
		const oauthId = validateSessionToken(oauth)!.sessionId;
		const otherId = validateSessionToken(other)!.sessionId;

		setAppLockTimeout(u.id, null);
		expect(unlockedUntilOf(oauthId)).toBeNull();
		expect(unlockedUntilOf(otherId)).toBe(12345);

		// Same for the admin's recovery switch.
		setAppLockTimeout(u.id, MIN);
		const { token: again } = createSession(u.id, null, 0);
		const againId = validateSessionToken(again)!.sessionId;
		clearAppLock(u.id);
		expect(unlockedUntilOf(againId)).toBeNull();
	});
});

describe('guards', () => {
	const locked = {
		user: null,
		sessionId: 's',
		appLock: { locked: true, sliding: true, userId: 'u', sessionId: 's', timeoutMs: MIN },
	} as App.Locals;

	it('the API answers 423 for a locked session, 401 for none', () => {
		expect(() => requireUser(locked)).toThrow(expect.objectContaining({ status: 423 }));
		expect(() => requireUser({ user: null, sessionId: null } as App.Locals)).toThrow(
			expect.objectContaining({ status: 401 }),
		);
	});

	it('pages send a locked session to /unlock, carrying where it was going', () => {
		seedUser(); // not a fresh install
		expect(() =>
			redirectUnauthenticatedPage(locked, new URL('http://x.test/chat/abc?m=1')),
		).toThrow(expect.objectContaining({ location: '/unlock?from=%2Fchat%2Fabc%3Fm%3D1' }));
	});

	it('the return target is restricted to a same-origin path', () => {
		expect(safeUnlockReturn('/chat/abc')).toBe('/chat/abc');
		expect(safeUnlockReturn('//evil.test')).toBe('/');
		expect(safeUnlockReturn('/\\evil.test')).toBe('/');
		expect(safeUnlockReturn('https://evil.test')).toBe('/');
		expect(safeUnlockReturn(null)).toBe('/');
		// The URL parser strips tab/newline before resolving, so these would
		// become `//evil.test` in a browser following the Location header.
		expect(safeUnlockReturn('/\t/evil.test')).toBe('/');
		expect(safeUnlockReturn('/\n/evil.test')).toBe('/');
		expect(safeUnlockReturn('/\r/evil.test')).toBe('/');
		expect(safeUnlockReturn('/\t\\evil.test')).toBe('/');
		// A same-origin path keeps its query and hash.
		expect(safeUnlockReturn('/chat/abc?m=1#x')).toBe('/chat/abc?m=1#x');
	});
});

describe('PUT /api/auth/app-lock', () => {
	function put(userId: string, sessionId: string, body: unknown, cookies = fakeCookies()) {
		return (putAppLock as unknown as (e: unknown) => Promise<Response>)({
			locals: { user: { id: userId }, sessionId },
			request: jsonRequest(body),
			cookies,
		});
	}

	it('turning it on needs a passkey ceremony', async () => {
		const u = seedUser();
		addPasskey(u.id, 'mine');
		const { token } = createSession(u.id);
		const sid = validateSessionToken(token)!.sessionId;
		// No challenge cookie → no ceremony happened.
		expect(await statusOf(() => put(u.id, sid, { timeoutMs: MIN }))).toBe(400);
		expect(getAppLockTimeout(u.id)).toBeNull();

		const cookies = fakeCookies({ glyphstream_passkey_unlock_challenge: 'c' });
		expect(
			await statusOf(() => put(u.id, sid, { timeoutMs: MIN, response: { id: 'mine' } }, cookies)),
		).toBe(200);
		expect(getAppLockTimeout(u.id)).toBe(MIN);
		// The session that turned it on keeps working.
		expect(unlockedUntilOf(sid)).toBeGreaterThan(Date.now());
	});

	it('refuses without a passkey, and refuses a window it does not offer', async () => {
		const u = seedUser();
		expect(await statusOf(() => put(u.id, 's', { timeoutMs: MIN }))).toBe(409);
		addPasskey(u.id, 'mine');
		expect(await statusOf(() => put(u.id, 's', { timeoutMs: 1234 }))).toBe(400);
	});

	it('changing the window or turning it off needs no ceremony', async () => {
		const u = seedUser();
		addPasskey(u.id, 'mine');
		setAppLockTimeout(u.id, MIN);
		expect(await statusOf(() => put(u.id, 's', { timeoutMs: 15 * MIN }))).toBe(200);
		expect(getAppLockTimeout(u.id)).toBe(15 * MIN);
		expect(await statusOf(() => put(u.id, 's', { timeoutMs: null }))).toBe(200);
		expect(getAppLockTimeout(u.id)).toBeNull();
	});
});

describe('POST /api/auth/unlock/verify', () => {
	function verify(locals: unknown, credentialId: string) {
		return (unlockVerify as unknown as (e: unknown) => Promise<Response>)({
			locals,
			cookies: fakeCookies({ glyphstream_passkey_unlock_challenge: 'c' }),
			request: jsonRequest({ response: { id: credentialId } }),
		});
	}

	it("refuses another account's passkey — a shared phone must not unlock your session", async () => {
		const me = seedUser();
		const housemate = seedUser();
		addPasskey(me.id, 'mine');
		addPasskey(housemate.id, 'theirs');
		setAppLockTimeout(me.id, MIN);
		const { token } = createSession(me.id, null, 0);
		const sid = validateSessionToken(token)!.sessionId;
		const locals = {
			user: null,
			sessionId: sid,
			appLock: { locked: true, sliding: true, userId: me.id, sessionId: sid, timeoutMs: MIN },
		};

		expect(await statusOf(() => verify(locals, 'theirs'))).toBe(401);
		expect(mocks.verified).toEqual([]);
		expect(unlockedUntilOf(sid)).toBe(0);

		expect(await statusOf(() => verify(locals, 'mine'))).toBe(200);
		expect(mocks.verified).toEqual(['mine']);
		expect(unlockedUntilOf(sid)).toBeGreaterThan(Date.now());
	});

	it('refuses a request with no session at all', async () => {
		expect(await statusOf(() => verify({ user: null, sessionId: null }, 'x'))).toBe(401);
	});
});

describe('lockout protection', () => {
	it("won't delete the last passkey while app lock is on", async () => {
		const u = seedUser();
		addPasskey(u.id, 'only');
		// A second method exists, so only the app-lock guard can refuse.
		addPasskey(u.id, 'other');
		setAppLockTimeout(u.id, MIN);
		const del = (id: string) =>
			(deletePasskey as unknown as (e: unknown) => Promise<Response>)({
				locals: { user: { id: u.id } },
				params: { id },
			});
		expect(await statusOf(() => del('other'))).toBe(204);
		expect(await statusOf(() => del('only'))).toBe(409);
	});

	it('an admin can turn a user’s app lock off, but not turn it on', async () => {
		const admin = seedUser(); // admin-ness comes from locals below
		const u = seedUser();
		setAppLockTimeout(u.id, MIN);
		const patch = (body: unknown) =>
			(adminPatch as unknown as (e: unknown) => Promise<Response>)({
				locals: { user: { id: admin.id, role: 'admin' } },
				params: { id: u.id },
				request: jsonRequest(body),
			});
		expect(await statusOf(() => patch({ appLock: true }))).toBe(400);
		expect(await statusOf(() => patch({ appLock: false }))).toBe(200);
		expect(getAppLockTimeout(u.id)).toBeNull();
		expect(clearAppLock(u.id)).toBe(false);
	});
});

describe('notifications', () => {
	async function notifyPayload(userId: string) {
		upsertPushSubscription({
			userId,
			endpoint: 'a',
			p256dh: 'BNcRdreALRFXTkOOUHK1EtK2wtZ1hcSSnZ2bX5J7ZK_4Q',
			auth: 'tBHItJI5svbpez7KI4CCXg', // gitleaks:allow — sample Web Push key, not a credential
		});
		await notifyConversationComplete({
			userId,
			conversationId: 'c1',
			assistantMessageId: 'm1',
			conversationTitle: 'Secret plans',
			previewText: 'The secret is…',
			modality: 'chat',
		});
		return JSON.parse(mocks.sendCalls[0]) as { conversationTitle?: string; preview?: string };
	}

	it('a lock suspended by PASSKEY_LOGIN_ENABLED=0 leaves previews to the user’s setting', async () => {
		mocks.passkeysEnabled = false;
		const u = seedUser();
		setUserPreferences(u.id, { notificationsEnabled: true, notificationsShowContent: true });
		setAppLockTimeout(u.id, MIN);
		const payload = await notifyPayload(u.id);
		expect(payload.conversationTitle).toBe('Secret plans');
		expect(payload.preview).toBeDefined();
	});

	it('app lock forces the show-content opt-out', async () => {
		const u = seedUser();
		setUserPreferences(u.id, { notificationsEnabled: true, notificationsShowContent: true });
		setAppLockTimeout(u.id, MIN);
		upsertPushSubscription({
			userId: u.id,
			endpoint: 'a',
			p256dh: 'BNcRdreALRFXTkOOUHK1EtK2wtZ1hcSSnZ2bX5J7ZK_4Q',
			auth: 'tBHItJI5svbpez7KI4CCXg', // gitleaks:allow — sample Web Push key, not a credential
		});
		await notifyConversationComplete({
			userId: u.id,
			conversationId: 'c1',
			assistantMessageId: 'm1',
			conversationTitle: 'Secret plans',
			previewText: 'The secret is…',
			modality: 'chat',
		});
		const payload = JSON.parse(mocks.sendCalls[0]) as {
			conversationTitle?: string;
			preview?: string;
		};
		expect(payload.conversationTitle).toBe(GENERIC_TITLE);
		expect(payload.preview).toBeUndefined();
	});
});
