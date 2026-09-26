/**
 * App lock: an installed-app session that has sat unused for the user's chosen
 * window needs a passkey (Face ID / Touch ID on Apple devices) before it can be
 * used again — the nearest a PWA can get to iOS's per-app "Require Face ID",
 * which the OS offers native apps but not home-screen web apps.
 *
 * Enforced by the SERVER, not by an overlay. A cold launch server-renders the
 * page, conversation list and all, before any client script could cover it, so
 * a client-side lock would lock nothing that matters. Instead a locked session
 * is treated by the session hook exactly like no session: `locals.user` is
 * null, so every existing guard refuses it without per-route changes. Guards
 * then tell "locked" from "signed out" by `locals.appLock` — pages redirect to
 * `/unlock`, the API answers 423.
 *
 * Three pieces of state:
 *
 * - `users.app_lock_timeout_ms` — the setting. Null = off.
 * - `sessions.unlocked_until` — the idle clock. Every request from the
 *   installed app slides it forward, so while the app is in use it never
 *   expires; once the app is backgrounded (iOS suspends its timers, so the
 *   visible-only keep-alive stops too) it runs out.
 * - the installed-app device cookie — which requests the idle lock applies to.
 *   The server can't see display-mode, so the client reports it once per launch
 *   (`POST /api/auth/app-lock/device`) and gets an httpOnly marker back. On iOS
 *   a home-screen app has its own cookie jar, separate from Safari's, so the
 *   marker scopes the lock to the installed app. Desktop Chrome and Android
 *   share one jar between the app and the browser, so there it covers the
 *   browser too, which errs toward locking more. The marker can only add a
 *   restriction, so the endpoint that sets it needs no auth.
 *
 * Scoping to the installed app leaves one bypass open: someone holding the
 * phone opens Safari (or a desktop browser) and uses "Sign in with GitHub"
 * against a provider session that's still live there. So an OAuth sign-in for
 * a user with app lock on mints a session that is BORN LOCKED
 * (`unlocked_until = 0`), in any browser, and needs a passkey before first use.
 * A passkey sign-in already did the user verification, so it starts unlocked.
 */

import { error, type Cookies } from '@sveltejs/kit';
import type { AuthenticationResponseJSON } from '@simplewebauthn/server';
import { and, eq, isNotNull } from 'drizzle-orm';
import { cookiesSecure, passkeyLoginEnabled } from '../env';
import { getDb, type Tx } from '../db/client';
import { sessions, users } from '../db/schema';
import { findCredentialById } from '../db/queries/passkey';
import {
	clearUnlockChallengeCookie,
	readUnlockChallengeCookie,
	verifyStoredCredentialAssertion,
} from './passkey';

const INSTALLED_APP_COOKIE = 'glyphstream_installed_app';
/** Chrome's cap on cookie lifetime; refreshed on every launch anyway. */
const INSTALLED_APP_COOKIE_MAX_AGE = 400 * 24 * 60 * 60;

/** What the session hook publishes on `locals.appLock`. */
export interface AppLockState {
	/** The session exists but may not be used until a passkey unlocks it. */
	locked: boolean;
	/**
	 * The idle clock applies to this request (installed app, lock on), so the
	 * client should keep it fed while visible and cover itself when hidden.
	 */
	sliding: boolean;
	userId: string;
	sessionId: string;
	timeoutMs: number;
}

export interface AppLockDecision {
	locked: boolean;
	sliding: boolean;
	/** New `unlocked_until` to write, or null for no write. */
	extendTo: number | null;
}

/**
 * The pure decision, for the session hook. `timeoutMs` null (lock off) — or
 * passkeys disabled instance-wide, which leaves nothing to unlock WITH —
 * short-circuits to unlocked everywhere.
 *
 * Writes are throttled like `last_seen_at`: the session read is on every
 * request, and paying a write per request for a minute-resolution clock would
 * be waste. The window is only slid once it has decayed by a quarter of the
 * timeout (capped at 30s), which is what bounds the keep-alive interval.
 */
export function evaluateAppLock(input: {
	timeoutMs: number | null;
	unlockedUntil: number | null;
	installedApp: boolean;
	passkeysEnabled: boolean;
	now: number;
}): AppLockDecision {
	const { timeoutMs, unlockedUntil, installedApp, now } = input;
	if (timeoutMs === null || !input.passkeysEnabled) {
		return { locked: false, sliding: false, extendTo: null };
	}
	// Born locked: an OAuth sign-in that hasn't been followed by a passkey yet.
	if (unlockedUntil === 0) return { locked: true, sliding: installedApp, extendTo: null };
	if (!installedApp) return { locked: false, sliding: false, extendTo: null };
	// NULL here means this session has never been unlocked under app lock (it
	// predates the setting, or the device cookie) — treat it as expired.
	const until = unlockedUntil ?? 0;
	if (now >= until) return { locked: true, sliding: true, extendTo: null };
	const remaining = until - now;
	const throttle = Math.min(30_000, timeoutMs / 4);
	// Also rewrite when the window is LONGER than the timeout, so shortening the
	// setting takes effect on the next request instead of after the old window.
	const extend = remaining < timeoutMs - throttle || remaining > timeoutMs;
	return { locked: false, sliding: true, extendTo: extend ? now + timeoutMs : null };
}

/**
 * `unlocked_until` for a freshly minted session. Only OAuth sign-ins are born
 * locked; a passkey sign-in starts with a full window. Lock off → null.
 */
export function initialUnlockedUntil(
	timeoutMs: number | null,
	method: 'passkey' | 'oauth',
	now: number = Date.now(),
): number | null {
	if (timeoutMs === null || !passkeyLoginEnabled()) return null;
	return method === 'oauth' ? 0 : now + timeoutMs;
}

// --- the setting ---------------------------------------------------------

/**
 * Whether app lock is in force for a user: set, AND unlockable. With passkeys
 * disabled instance-wide nothing could unlock it, so a stored setting is
 * suspended rather than enforced — the same rule `evaluateAppLock` applies.
 */
export function isAppLockActive(userId: string): boolean {
	return passkeyLoginEnabled() && getAppLockTimeout(userId) !== null;
}

export function getAppLockTimeout(userId: string): number | null {
	const row = getDb()
		.select({ t: users.appLockTimeoutMs })
		.from(users)
		.where(eq(users.id, userId))
		.get();
	return row?.t ?? null;
}

/** Returns false when no such user exists. */
export function setAppLockTimeout(userId: string, timeoutMs: number | null): boolean {
	return getDb().transaction((tx) => {
		const res = tx
			.update(users)
			.set({ appLockTimeoutMs: timeoutMs })
			.where(eq(users.id, userId))
			.run();
		if (timeoutMs === null) clearBornLocked(tx, userId);
		return res.changes > 0;
	});
}

/** Admin recovery: turn a user's app lock off. False when it wasn't on. */
export function clearAppLock(userId: string): boolean {
	return getDb().transaction((tx) => {
		const res = tx
			.update(users)
			.set({ appLockTimeoutMs: null })
			.where(and(eq(users.id, userId), isNotNull(users.appLockTimeoutMs)))
			.run();
		clearBornLocked(tx, userId);
		return res.changes > 0;
	});
}

/**
 * Turning the lock off retires the born-locked marker along with it. `0` only
 * means something while the lock is on, and left behind it would outlive the
 * setting: an OAuth session used freely in a desktop browser for weeks would
 * lock in EVERY browser the moment the lock was turned back on, rather than
 * behaving like any other session the user already had.
 */
function clearBornLocked(tx: Tx, userId: string): void {
	tx.update(sessions)
		.set({ unlockedUntil: null })
		.where(and(eq(sessions.userId, userId), eq(sessions.unlockedUntil, 0)))
		.run();
}

// --- the device marker ----------------------------------------------------

export function readInstalledAppCookie(cookies: Cookies): boolean {
	return cookies.get(INSTALLED_APP_COOKIE) === '1';
}

export function setInstalledAppCookie(cookies: Cookies): void {
	cookies.set(INSTALLED_APP_COOKIE, '1', {
		path: '/',
		httpOnly: true,
		sameSite: 'lax',
		secure: cookiesSecure(),
		maxAge: INSTALLED_APP_COOKIE_MAX_AGE,
	});
}

// --- the ceremony ----------------------------------------------------------

/**
 * Verify the unlock ceremony's assertion for `userId`: reads + clears the
 * challenge cookie, requires that the credential belongs to THIS user (not
 * merely to someone registered on the instance — a housemate's passkey on the
 * same phone must not unlock your session), then runs the shared assertion
 * check. Throws the appropriate `error()` on any failure.
 */
export async function verifyUnlockAssertion(
	cookies: Cookies,
	response: unknown,
	userId: string,
): Promise<void> {
	const challenge = readUnlockChallengeCookie(cookies);
	clearUnlockChallengeCookie(cookies);
	if (!challenge) error(400, 'Missing or expired challenge');
	if (
		!response ||
		typeof response !== 'object' ||
		typeof (response as { id?: unknown }).id !== 'string'
	) {
		error(400, 'Missing authentication response');
	}
	const assertion = response as AuthenticationResponseJSON;
	const credential = findCredentialById(assertion.id);
	if (!credential || credential.userId !== userId) {
		error(401, "That passkey doesn't belong to this account");
	}
	await verifyStoredCredentialAssertion(assertion, challenge, credential, 'app-lock');
}
