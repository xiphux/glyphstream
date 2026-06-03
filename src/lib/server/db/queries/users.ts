/**
 * User-row queries. The model has shifted: the row no longer carries
 * any provider-specific identity (those moved to `oauth_accounts`),
 * and creation is a deliberate one-shot driven by PR 2's `/setup`
 * wizard. Login flows no longer create users; they look them up via
 * `findUserByOAuth` (OAuth) or `findUserForCredential` (passkey) and
 * call `bumpUserLastLogin` if successful.
 */
import { eq } from 'drizzle-orm';
import { generateId } from '../../util/id';
import { getDb } from '../client';
import { users } from '../schema';

export interface CreateInitialUserInput {
	/** Optional pre-allocated id; the passkey `/setup` flow needs this
	 *  because the credential's userHandle is fixed at registration
	 *  time and must match the eventual `users.id`. */
	id?: string;
	displayName: string;
	email: string | null;
}

/**
 * Create the one-and-only user row. Refuses with a thrown error when
 * a user already exists — that's the single-user-cap enforcement at
 * the data layer. Callers (`/setup`-verify endpoints) check
 * `countUsers() === 0` first for a clean 4xx; this throw is the
 * defense-in-depth backstop against a race.
 */
export function createInitialUser(input: CreateInitialUserInput): string {
	const db = getDb();
	if (countUsers() > 0) {
		throw new Error('createInitialUser: a user already exists; setup is closed');
	}
	const id = input.id ?? generateId();
	const now = Date.now();
	db.insert(users)
		.values({
			id,
			displayName: input.displayName,
			email: input.email,
			createdAt: now,
			lastLoginAt: now,
			disabledAt: null,
		})
		.run();
	return id;
}

/**
 * Counts the rows in `users`. Used by the single-user-cap check in
 * both the OAuth callback (refuse new bindings when count > 0 and the
 * external_id isn't already bound) and the `/setup` gate (only
 * reachable when count === 0).
 */
export function countUsers(): number {
	const db = getDb();
	const rows = db.select({ id: users.id }).from(users).all();
	return rows.length;
}

/**
 * Read just the disabled flag — used by session validation to refuse
 * a request mid-flight when the operator flips the bit, rather than
 * waiting until the next login.
 */
export function getDisabledAt(userId: string): number | null {
	const db = getDb();
	const row = db
		.select({ disabledAt: users.disabledAt })
		.from(users)
		.where(eq(users.id, userId))
		.get();
	return row?.disabledAt ?? null;
}

/**
 * Bump `last_login_at` without touching any other field. Called by
 * every successful login path (OAuth callback, passkey verify) so
 * the "when did the operator last sign in" stat stays accurate
 * regardless of which method they used.
 */
export function bumpUserLastLogin(userId: string): void {
	const db = getDb();
	db.update(users).set({ lastLoginAt: Date.now() }).where(eq(users.id, userId)).run();
}
