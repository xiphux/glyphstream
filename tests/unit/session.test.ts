/**
 * Auth session tests — security-critical. The cookie-vs-DB split (raw
 * token in the cookie, sha256 in the DB) is exactly the kind of
 * invariant a refactor could quietly invert; a regression there would
 * mean a DB read = a forgeable cookie. Covered explicitly.
 *
 * Also covers expiry (purges the row on read), renewal threshold,
 * and the cookie helpers' set/clear/read round-trip on SvelteKit's
 * Cookies surface.
 */

import process from 'node:process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { createTestDb, closeTestDb, type TestDB } from './_helpers/test-db';
import { seedUser } from './_helpers/seed';

const mocks = vi.hoisted(() => ({ testDb: null as unknown as TestDB }));
vi.mock('$lib/server/db/client', () => ({
	getDb: () => mocks.testDb,
	closeDb: () => {},
}));

import {
	clearSessionCookie,
	createSession,
	SESSION_ABSOLUTE_MAX_MS,
	listSessionsForUser,
	revokeOtherSessionsForUser,
	revokeSessionForUser,
	invalidateSession,
	readSessionCookie,
	setSessionCookie,
	validateSessionToken,
} from '$lib/server/auth/session';
import { sessions } from '$lib/server/db/schema';

function hash(s: string): string {
	return createHash('sha256').update(s).digest('hex');
}

beforeEach(() => {
	mocks.testDb = createTestDb();
});

afterEach(() => {
	closeTestDb();
});

describe('createSession', () => {
	it('returns a token and an expiry 30 days out', () => {
		const u = seedUser();
		const before = Date.now();
		const { token, expiresAt } = createSession(u.id);
		expect(typeof token).toBe('string');
		expect(token.length).toBeGreaterThan(0);
		// 30 days = 30 * 24 * 60 * 60 * 1000 = 2,592,000,000 ms
		expect(expiresAt - before).toBeGreaterThanOrEqual(30 * 24 * 60 * 60 * 1000 - 1000);
		expect(expiresAt - before).toBeLessThanOrEqual(30 * 24 * 60 * 60 * 1000 + 1000);
	});

	it('stores the HASH in the DB, not the raw token', () => {
		const u = seedUser();
		const { token } = createSession(u.id);
		// Raw token should NOT be in the sessions table — a DB compromise
		// can't be replayed as a valid cookie if this invariant holds.
		const byRaw = mocks.testDb.select().from(sessions).where(eq(sessions.id, token)).get();
		expect(byRaw).toBeUndefined();
		// The hashed form is what's stored.
		const byHash = mocks.testDb
			.select()
			.from(sessions)
			.where(eq(sessions.id, hash(token)))
			.get();
		expect(byHash).toBeDefined();
		expect(byHash!.userId).toBe(u.id);
	});

	it('issues a fresh token on each call (no token reuse)', () => {
		const u = seedUser();
		const a = createSession(u.id);
		const b = createSession(u.id);
		expect(a.token).not.toBe(b.token);
	});
});

describe('validateSessionToken', () => {
	it('returns null for an empty string', () => {
		expect(validateSessionToken('')).toBeNull();
	});

	it('returns null for an unknown token', () => {
		expect(validateSessionToken('not-a-real-token')).toBeNull();
	});

	it('returns the AuthContext for a valid token, with sessionId set to the HASH', () => {
		const u = seedUser({ displayName: 'Alice' });
		const { token, expiresAt } = createSession(u.id);
		const ctx = validateSessionToken(token);
		expect(ctx).not.toBeNull();
		expect(ctx!.user.id).toBe(u.id);
		expect(ctx!.user.displayName).toBe('Alice');
		// sessionId returned to callers is the DB key (hash), not the raw
		// token — invalidate() and other downstream operations work on it.
		expect(ctx!.sessionId).toBe(hash(token));
		expect(ctx!.sessionId).not.toBe(token);
		// Renewal hasn't fired yet (well past threshold), so expiresAt
		// matches the row.
		expect(ctx!.expiresAt).toBe(expiresAt);
	});

	it('returns null AND deletes the row when the session is expired', () => {
		const u = seedUser();
		// Insert an already-expired session row directly.
		const rawToken = randomBytes(20).toString('base64url');
		const sessionId = hash(rawToken);
		mocks.testDb
			.insert(sessions)
			.values({ id: sessionId, userId: u.id, expiresAt: Date.now() - 1000, createdAt: Date.now() })
			.run();

		expect(validateSessionToken(rawToken)).toBeNull();
		const after = mocks.testDb.select().from(sessions).where(eq(sessions.id, sessionId)).get();
		expect(after).toBeUndefined();
	});

	it('renews the session when within the 7-day renewal threshold', () => {
		const u = seedUser();
		const rawToken = randomBytes(20).toString('base64url');
		const sessionId = hash(rawToken);
		// 1 day until expiry — inside the 7-day renewal window.
		const aboutToExpire = Date.now() + 24 * 60 * 60 * 1000;
		mocks.testDb
			.insert(sessions)
			.values({ id: sessionId, userId: u.id, expiresAt: aboutToExpire, createdAt: Date.now() })
			.run();

		const ctx = validateSessionToken(rawToken);
		expect(ctx).not.toBeNull();
		// New expiry should be ~30 days out, not the original 1-day window.
		expect(ctx!.expiresAt).toBeGreaterThan(aboutToExpire + 7 * 24 * 60 * 60 * 1000);

		// Renewed value is persisted, not just returned in memory.
		const row = mocks.testDb.select().from(sessions).where(eq(sessions.id, sessionId)).get();
		expect(row!.expiresAt).toBe(ctx!.expiresAt);
	});

	it('does NOT renew when outside the renewal threshold (>7 days remaining)', () => {
		const u = seedUser();
		const { token, expiresAt } = createSession(u.id);
		const ctx = validateSessionToken(token);
		expect(ctx!.expiresAt).toBe(expiresAt);
		const row = mocks.testDb
			.select()
			.from(sessions)
			.where(eq(sessions.id, hash(token)))
			.get();
		expect(row!.expiresAt).toBe(expiresAt);
	});
});

describe('invalidateSession', () => {
	it('removes the session row by its hashed id', () => {
		const u = seedUser();
		const { token } = createSession(u.id);
		const ctx = validateSessionToken(token);
		invalidateSession(ctx!.sessionId);
		expect(validateSessionToken(token)).toBeNull();
	});
});

describe('cookie helpers', () => {
	/** Minimal in-memory Cookies stub matching SvelteKit's surface area. */
	function fakeCookies() {
		const store = new Map<string, string>();
		return {
			store,
			get(name: string) {
				return store.get(name);
			},
			set(name: string, value: string, _opts: unknown) {
				store.set(name, value);
			},
			delete(name: string, _opts: unknown) {
				store.delete(name);
			},
		};
	}

	it('round-trips through set/read/clear', () => {
		const c = fakeCookies();
		setSessionCookie(c as never, 'tok-123', Date.now() + 1000);
		expect(c.store.get('glyphstream_session')).toBe('tok-123');
		expect(readSessionCookie(c as never)).toBe('tok-123');
		clearSessionCookie(c as never);
		expect(c.store.has('glyphstream_session')).toBe(false);
		expect(readSessionCookie(c as never)).toBeUndefined();
	});
});

describe('absolute session lifetime', () => {
	const DAY = 24 * 60 * 60 * 1000;

	/** Insert a session with explicit issue + expiry instants. */
	function seedSession(userId: string, createdAt: number, expiresAt: number) {
		const rawToken = randomBytes(20).toString('base64url');
		mocks.testDb
			.insert(sessions)
			.values({ id: hash(rawToken), userId, expiresAt, createdAt })
			.run();
		return rawToken;
	}

	it('signals renewal so the caller can re-issue the cookie', () => {
		// Renewal used to slide expires_at in the DB while nothing re-issued
		// the cookie, so the browser kept its original `expires`. The
		// legitimate user got signed out 30 days after issue however active
		// they were, while an exfiltrated raw token — bound by no cookie
		// attribute at all — kept renewing its row indefinitely.
		const u = seedUser();
		const token = seedSession(u.id, Date.now(), Date.now() + DAY);
		expect(validateSessionToken(token)!.renewed).toBe(true);
	});

	it('does not signal renewal when outside the threshold', () => {
		const u = seedUser();
		const { token } = createSession(u.id);
		expect(validateSessionToken(token)!.renewed).toBe(false);
	});

	it('refuses a session kept warm past the absolute ceiling', () => {
		// The whole point: sliding renewal has no ceiling of its own, so a
		// token used once every 23 days lives forever. That asymmetry favours
		// an attacker holding a stolen token over the real user.
		const u = seedUser();
		const issued = Date.now() - SESSION_ABSOLUTE_MAX_MS - 1;
		const token = seedSession(u.id, issued, Date.now() + 10 * DAY);
		expect(validateSessionToken(token)).toBeNull();
	});

	it('purges the row when the ceiling retires a session', () => {
		const u = seedUser();
		const issued = Date.now() - SESSION_ABSOLUTE_MAX_MS - 1;
		const token = seedSession(u.id, issued, Date.now() + 10 * DAY);
		validateSessionToken(token);
		expect(mocks.testDb.select().from(sessions).all()).toHaveLength(0);
	});

	it('clamps a renewal to the ceiling instead of stepping over it', () => {
		// Approaching the deadline, renewal should taper to land exactly on
		// it rather than granting another full 30 days past it.
		const u = seedUser();
		const issued = Date.now() - (SESSION_ABSOLUTE_MAX_MS - 2 * DAY);
		const token = seedSession(u.id, issued, Date.now() + DAY);
		const ctx = validateSessionToken(token)!;
		expect(ctx.expiresAt).toBe(issued + SESSION_ABSOLUTE_MAX_MS);
		expect(ctx.expiresAt).toBeLessThan(Date.now() + 30 * DAY);
	});

	it('stamps created_at on a freshly issued session', () => {
		const u = seedUser();
		const before = Date.now();
		createSession(u.id);
		const row = mocks.testDb.select().from(sessions).all()[0];
		expect(row.createdAt).toBeGreaterThanOrEqual(before);
		expect(row.createdAt).toBeLessThanOrEqual(Date.now());
	});
});

describe('session listing + revocation', () => {
	const DAY = 24 * 60 * 60 * 1000;

	function mint(userId: string, userAgent: string | null = null) {
		return createSession(userId, userAgent);
	}

	it('lists a user’s own live sessions, most recently active first', () => {
		const u = seedUser();
		mint(u.id, 'Chrome');
		mint(u.id, 'Safari');
		const list = listSessionsForUser(u.id);
		expect(list).toHaveLength(2);
		expect(list.map((s) => s.userAgent).sort()).toEqual(['Chrome', 'Safari']);
	});

	it('never lists another user’s sessions', () => {
		const a = seedUser();
		const b = seedUser({ email: 'b@x.test' });
		mint(a.id);
		mint(b.id);
		expect(listSessionsForUser(a.id)).toHaveLength(1);
		expect(listSessionsForUser(b.id)).toHaveLength(1);
	});

	it('omits expired sessions from the list', () => {
		// They're already dead to validateSessionToken, but only get swept
		// when their own token is next presented — which for an abandoned
		// device never happens.
		const u = seedUser();
		const rawToken = randomBytes(20).toString('base64url');
		mocks.testDb
			.insert(sessions)
			.values({
				id: hash(rawToken),
				userId: u.id,
				expiresAt: Date.now() - 1,
				createdAt: Date.now() - DAY,
			})
			.run();
		expect(listSessionsForUser(u.id)).toHaveLength(0);
	});

	it('truncates a long User-Agent rather than storing it whole', () => {
		const u = seedUser();
		mint(u.id, 'x'.repeat(5000));
		expect(listSessionsForUser(u.id)[0].userAgent!.length).toBeLessThanOrEqual(256);
	});

	it('revokes one session, and the token stops resolving', () => {
		const u = seedUser();
		const { token } = mint(u.id);
		const id = listSessionsForUser(u.id)[0].id;
		expect(revokeSessionForUser(u.id, id)).toBe(true);
		expect(validateSessionToken(token)).toBeNull();
	});

	it('refuses to revoke a session belonging to someone else', () => {
		// Scoped by user id, so a foreign session id matches nothing — the
		// ids are unguessable sha256 hashes, but the scope is the invariant.
		const a = seedUser();
		const b = seedUser({ email: 'b@x.test' });
		const { token: bToken } = mint(b.id);
		const bSessionId = listSessionsForUser(b.id)[0].id;

		expect(revokeSessionForUser(a.id, bSessionId)).toBe(false);
		expect(validateSessionToken(bToken)).not.toBeNull();
	});

	it('signs out every other session but keeps the caller’s', () => {
		const u = seedUser();
		const keep = mint(u.id);
		mint(u.id);
		mint(u.id);
		const keepId = hash(keep.token);

		expect(revokeOtherSessionsForUser(u.id, keepId)).toBe(2);
		expect(validateSessionToken(keep.token)).not.toBeNull();
		expect(listSessionsForUser(u.id)).toHaveLength(1);
	});

	it('signing out everywhere else leaves other users untouched', () => {
		const a = seedUser();
		const b = seedUser({ email: 'b@x.test' });
		const aKeep = mint(a.id);
		mint(a.id);
		const { token: bToken } = mint(b.id);

		revokeOtherSessionsForUser(a.id, hash(aKeep.token));
		expect(validateSessionToken(bToken)).not.toBeNull();
		expect(listSessionsForUser(b.id)).toHaveLength(1);
	});
});

describe('cookie Secure attribute', () => {
	it('is derived from EXTERNAL_BASE_URL, not NODE_ENV', async () => {
		// It used to key off NODE_ENV, which the Dockerfile sets but nothing
		// else does — a `node build` under systemd shipped session cookies
		// with no Secure attribute and no warning. EXTERNAL_BASE_URL has to be
		// right already (the WebAuthn RP ID and OAuth redirect both derive
		// from it), so keying to it fails safe instead.
		const { cookiesSecure } = await import('$lib/server/env');
		const previous = process.env.EXTERNAL_BASE_URL;
		const previousNodeEnv = process.env.NODE_ENV;
		try {
			process.env.NODE_ENV = 'development';
			process.env.EXTERNAL_BASE_URL = 'https://chat.example.com';
			expect(cookiesSecure()).toBe(true);

			process.env.NODE_ENV = 'production';
			process.env.EXTERNAL_BASE_URL = 'http://localhost:5173';
			expect(cookiesSecure()).toBe(false);
		} finally {
			if (previous === undefined) delete process.env.EXTERNAL_BASE_URL;
			else process.env.EXTERNAL_BASE_URL = previous;
			if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
			else process.env.NODE_ENV = previousNodeEnv;
		}
	});
});
