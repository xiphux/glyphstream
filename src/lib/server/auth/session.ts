import { createHash, randomBytes } from 'node:crypto';
import { and, eq, isNull } from 'drizzle-orm';
import type { Cookies } from '@sveltejs/kit';
import { getDb } from '../db/client';
import { sessions, users } from '../db/schema';

const SESSION_COOKIE = 'glyphstream_session';
const SESSION_DURATION_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const SESSION_RENEWAL_THRESHOLD_MS = 7 * 24 * 60 * 60 * 1000; // renew if <7 days left

/**
 * Sessions are opaque random tokens. The cookie holds the *raw* token; the
 * DB stores the *sha256* of it. This way a DB compromise can't be replayed
 * as a valid cookie — the attacker would need to invert the hash.
 */
function hashToken(raw: string): string {
	return createHash('sha256').update(raw).digest('hex');
}

function generateToken(): string {
	// 160 bits of entropy, base64url-encoded (~27 chars).
	return randomBytes(20).toString('base64url');
}

export interface SessionUser {
	id: string;
	displayName: string | null;
	email: string | null;
	role: 'admin' | 'user';
}

export interface AuthContext {
	user: SessionUser;
	sessionId: string;
	expiresAt: number;
}

/** Create a new session row + return the raw cookie token to set. */
export function createSession(userId: string): { token: string; expiresAt: number } {
	const token = generateToken();
	const sessionId = hashToken(token);
	const expiresAt = Date.now() + SESSION_DURATION_MS;
	const db = getDb();
	db.insert(sessions).values({ id: sessionId, userId, expiresAt }).run();
	return { token, expiresAt };
}

/**
 * Look up the session by its cookie token. Auto-renews when within the
 * renewal threshold, expires when past `expires_at`. Returns null on any
 * failure path so callers can treat it as "no auth."
 */
export function validateSessionToken(token: string): AuthContext | null {
	if (!token) return null;
	const sessionId = hashToken(token);
	const db = getDb();
	// `users.disabled_at IS NULL` filter on the join means an operator
	// flipping the disabled bit invalidates every active session for
	// that user at the next request, not just at next login. The
	// session row stays in the DB (so re-enabling restores access
	// without re-issuing a token) but it stops resolving until the
	// disabled flag clears.
	const row = db
		.select({
			sessionId: sessions.id,
			expiresAt: sessions.expiresAt,
			user: users,
		})
		.from(sessions)
		.innerJoin(users, eq(sessions.userId, users.id))
		.where(and(eq(sessions.id, sessionId), isNull(users.disabledAt)))
		.get();
	if (!row) return null;

	const now = Date.now();
	if (row.expiresAt <= now) {
		db.delete(sessions).where(eq(sessions.id, sessionId)).run();
		return null;
	}

	let expiresAt = row.expiresAt;
	if (row.expiresAt - now < SESSION_RENEWAL_THRESHOLD_MS) {
		expiresAt = now + SESSION_DURATION_MS;
		db.update(sessions).set({ expiresAt }).where(eq(sessions.id, sessionId)).run();
	}

	return {
		sessionId: row.sessionId,
		expiresAt,
		user: {
			id: row.user.id,
			displayName: row.user.displayName,
			email: row.user.email,
			role: row.user.role,
		},
	};
}

export function invalidateSession(sessionId: string): void {
	const db = getDb();
	db.delete(sessions).where(eq(sessions.id, sessionId)).run();
}

// --- cookie wrangling ----------------------------------------------------

export function setSessionCookie(cookies: Cookies, token: string, expiresAt: number): void {
	cookies.set(SESSION_COOKIE, token, {
		path: '/',
		httpOnly: true,
		sameSite: 'lax',
		secure: process.env.NODE_ENV === 'production',
		expires: new Date(expiresAt),
	});
}

export function clearSessionCookie(cookies: Cookies): void {
	cookies.delete(SESSION_COOKIE, { path: '/' });
}

export function readSessionCookie(cookies: Cookies): string | undefined {
	return cookies.get(SESSION_COOKIE);
}
