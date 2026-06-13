/**
 * User-row queries. The model has shifted: the row no longer carries
 * any provider-specific identity (those moved to `oauth_accounts`),
 * and creation is a deliberate one-shot driven by PR 2's `/setup`
 * wizard. Login flows no longer create users; they look them up via
 * `findUserByOAuth` (OAuth) or `findUserForCredential` (passkey) and
 * call `bumpUserLastLogin` if successful.
 */
import { and, desc, eq, isNull } from 'drizzle-orm';
import { generateId } from '../../util/id';
import { getDb, type Tx } from '../client';
import { users } from '../schema';

export type UserRole = 'admin' | 'user';

export interface CreateUserInput {
	/** Optional pre-allocated id; the passkey flows need this because the
	 *  credential's userHandle is fixed at registration time and must match
	 *  the eventual `users.id`. */
	id?: string;
	displayName: string;
	email: string | null;
	role: UserRole;
}

export interface CreateInitialUserInput {
	id?: string;
	displayName: string;
	email: string | null;
}

/**
 * Insert a user row. No single-user guard — this is the multi-user creation
 * path: the setup wizard mints the first user (admin) via `createInitialUser`,
 * and invite redemption mints the rest here. Pass `tx` to run inside a
 * caller's transaction — invite redemption creates the user AND consumes the
 * invite atomically, so a crash can't leave a used invite with no user (or a
 * user with a still-reusable invite).
 */
export function createUser(input: CreateUserInput, tx?: Tx): string {
	const exec = tx ?? getDb();
	const id = input.id ?? generateId();
	const now = Date.now();
	exec
		.insert(users)
		.values({
			id,
			displayName: input.displayName,
			email: input.email,
			role: input.role,
			createdAt: now,
			lastLoginAt: now,
			disabledAt: null,
		})
		.run();
	return id;
}

/**
 * Create the very-first user via the `/setup` wizard, as an admin. Refuses
 * with a thrown error when a user already exists — that's the setup-cap
 * backstop against a race. Callers (`/setup`-verify endpoints) check
 * `countUsers() === 0` first for a clean 4xx; this throw is defense-in-depth.
 */
export function createInitialUser(input: CreateInitialUserInput): string {
	if (countUsers() > 0) {
		throw new Error('createInitialUser: a user already exists; setup is closed');
	}
	return createUser({ ...input, role: 'admin' });
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

export interface UserSummary {
	id: string;
	displayName: string | null;
	email: string | null;
	role: UserRole;
	disabledAt: number | null;
	createdAt: number;
	lastLoginAt: number | null;
}

/** All users, newest-first — for the admin user-management table. */
export function listUsers(): UserSummary[] {
	const db = getDb();
	return db
		.select({
			id: users.id,
			displayName: users.displayName,
			email: users.email,
			role: users.role,
			disabledAt: users.disabledAt,
			createdAt: users.createdAt,
			lastLoginAt: users.lastLoginAt,
		})
		.from(users)
		.orderBy(desc(users.createdAt))
		.all();
}

/**
 * Count active (non-disabled) admins. The admin API uses this to refuse any
 * action that would drop the active-admin count to zero — disabling or
 * deleting the last admin would lock the instance out of its own
 * user-management UI with no recovery path short of editing the DB.
 */
export function countActiveAdmins(): number {
	const db = getDb();
	return db
		.select({ id: users.id })
		.from(users)
		.where(and(eq(users.role, 'admin'), isNull(users.disabledAt)))
		.all().length;
}

/** Read a user's role (used where the session context isn't to hand). */
export function getUserRole(userId: string): UserRole | null {
	const db = getDb();
	const row = db.select({ role: users.role }).from(users).where(eq(users.id, userId)).get();
	return row?.role ?? null;
}

/**
 * Toggle the operator-disabled flag. Disabling invalidates the user's
 * sessions at their next request (see the join in `validateSessionToken`)
 * and refuses new logins; enabling clears it. Returns false if no row
 * matched.
 */
export function setUserDisabled(userId: string, disabled: boolean): boolean {
	const db = getDb();
	const res = db
		.update(users)
		.set({ disabledAt: disabled ? Date.now() : null })
		.where(eq(users.id, userId))
		.run();
	return res.changes > 0;
}

/**
 * Delete a user and everything they own (sessions, oauth bindings, passkeys,
 * conversations, custom models, media, etc. — all cascade via FK). Returns
 * false if no row matched.
 */
export function deleteUser(userId: string): boolean {
	const db = getDb();
	const res = db.delete(users).where(eq(users.id, userId)).run();
	return res.changes > 0;
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
