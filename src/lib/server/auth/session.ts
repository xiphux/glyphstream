import { createHash, randomBytes } from 'node:crypto';
import { and, eq, isNull } from 'drizzle-orm';
import type { Cookies } from '@sveltejs/kit';
import { getDb } from '../db/client';
import { sessions, users } from '../db/schema';

const SESSION_COOKIE = 'glyphstream_session';
const SESSION_DURATION_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const SESSION_RENEWAL_THRESHOLD_MS = 7 * 24 * 60 * 60 * 1000; // renew if <7 days left

/**
 * Hard ceiling on a session's total life, measured from issue rather than
 * from last use.
 *
 * Sliding renewal alone has no ceiling: a token stays valid forever as long as
 * it's used once every 23 days. That asymmetry favours an attacker — the
 * legitimate user reaches for the app in bursts, while an exfiltrated token
 * can be kept warm by a script indefinitely. Ninety days means a compromise
 * that goes unnoticed still ends on its own.
 */
export const SESSION_ABSOLUTE_MAX_MS = 90 * 24 * 60 * 60 * 1000; // 90 days

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
	/**
	 * True when this validation slid `expires_at` forward. The caller must
	 * re-issue the cookie — see the note on {@link validateSessionToken}.
	 */
	renewed: boolean;
}

/** Create a new session row + return the raw cookie token to set. */
export function createSession(userId: string): { token: string; expiresAt: number } {
	const token = generateToken();
	const sessionId = hashToken(token);
	const now = Date.now();
	const expiresAt = now + SESSION_DURATION_MS;
	const db = getDb();
	db.insert(sessions).values({ id: sessionId, userId, expiresAt, createdAt: now }).run();
	return { token, expiresAt };
}

/**
 * Look up the session by its cookie token. Auto-renews when within the
 * renewal threshold, expires when past `expires_at` or past the absolute
 * ceiling. Returns null on any failure path so callers can treat it as
 * "no auth."
 *
 * When this renews, it sets `renewed` on the returned context and the caller
 * MUST call `setSessionCookie` again. Renewal used to move `expires_at` in the
 * DB while nothing re-issued the cookie, so the browser kept its original
 * `expires` date — which cut both ways. A legitimate user got signed out 30
 * days after issue no matter how active they were, while an exfiltrated raw
 * token, unbound by any cookie attribute, kept renewing its row forever.
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
	//
	// Only the four `SessionUser` columns are projected. Selecting the whole
	// `users` row would decode `preferences_json` and `conversation_overview`
	// (the injected topic map — multiple KB once the summary worker has run)
	// out of SQLite on *every* request, including presence heartbeats, to
	// throw them away here.
	const row = db
		.select({
			sessionId: sessions.id,
			expiresAt: sessions.expiresAt,
			createdAt: sessions.createdAt,
			userId: users.id,
			displayName: users.displayName,
			email: users.email,
			role: users.role,
		})
		.from(sessions)
		.innerJoin(users, eq(sessions.userId, users.id))
		.where(and(eq(sessions.id, sessionId), isNull(users.disabledAt)))
		.get();
	if (!row) return null;

	const now = Date.now();
	// The absolute ceiling is checked alongside the sliding expiry, so a
	// session that has been kept warm past it dies here rather than renewing.
	const absoluteDeadline = row.createdAt + SESSION_ABSOLUTE_MAX_MS;
	if (row.expiresAt <= now || now >= absoluteDeadline) {
		db.delete(sessions).where(eq(sessions.id, sessionId)).run();
		return null;
	}

	let expiresAt = row.expiresAt;
	let renewed = false;
	if (row.expiresAt - now < SESSION_RENEWAL_THRESHOLD_MS) {
		// Clamp to the ceiling so renewal tapers off as it approaches rather
		// than stepping over it — the last renewal lands exactly on the
		// deadline, and the check above retires the session there.
		const next = Math.min(now + SESSION_DURATION_MS, absoluteDeadline);
		if (next > row.expiresAt) {
			expiresAt = next;
			renewed = true;
			db.update(sessions).set({ expiresAt }).where(eq(sessions.id, sessionId)).run();
		}
	}

	return {
		sessionId: row.sessionId,
		expiresAt,
		renewed,
		user: {
			id: row.userId,
			displayName: row.displayName,
			email: row.email,
			role: row.role,
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
