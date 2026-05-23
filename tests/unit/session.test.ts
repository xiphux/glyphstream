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

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { createTestDb, closeTestDb, type TestDB } from './_helpers/test-db';
import { seedUser } from './_helpers/seed';

const mocks = vi.hoisted(() => ({ testDb: null as unknown as TestDB }));
vi.mock('$lib/server/db/client', () => ({
	getDb: () => mocks.testDb,
	closeDb: () => {}
}));

import {
	clearSessionCookie,
	createSession,
	invalidateSession,
	readSessionCookie,
	setSessionCookie,
	validateSessionToken
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
		const byHash = mocks.testDb.select().from(sessions).where(eq(sessions.id, hash(token))).get();
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
		const u = seedUser({ githubUsername: 'alice' });
		const { token, expiresAt } = createSession(u.id);
		const ctx = validateSessionToken(token);
		expect(ctx).not.toBeNull();
		expect(ctx!.user.id).toBe(u.id);
		expect(ctx!.user.githubUsername).toBe('alice');
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
			.values({ id: sessionId, userId: u.id, expiresAt: Date.now() - 1000 })
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
			.values({ id: sessionId, userId: u.id, expiresAt: aboutToExpire })
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
		const row = mocks.testDb.select().from(sessions).where(eq(sessions.id, hash(token))).get();
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
			}
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
