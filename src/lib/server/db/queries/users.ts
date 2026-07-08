/**
 * User-row queries. The model has shifted: the row no longer carries
 * any provider-specific identity (those moved to `oauth_accounts`),
 * and creation is a deliberate one-shot driven by PR 2's `/setup`
 * wizard. Login flows no longer create users; they look them up via
 * `findUserByOAuth` (OAuth) or `findUserForCredential` (passkey) and
 * call `bumpUserLastLogin` if successful.
 */
import { and, asc, count, desc, eq, isNotNull, isNull, sql } from 'drizzle-orm';
import { generateId } from '../../util/id';
import { getDb, type Tx } from '../client';
import { conversations, users } from '../schema';

export type UserRole = 'admin' | 'user';

export interface CreateUserInput {
	/** Optional pre-allocated id; the passkey flows need this because the
	 *  credential's userHandle is fixed at registration time and must match
	 *  the eventual `users.id`. */
	id?: string;
	displayName: string;
	email: string | null;
	role: UserRole;
	/** The admin whose invite created this account, denormalized off the
	 *  (then-deleted) invite. Null for the setup-wizard admin / non-invited
	 *  users. */
	invitedByUserId?: string | null;
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
			invitedByUserId: input.invitedByUserId ?? null,
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
	invitedByUserId: string | null;
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
			invitedByUserId: users.invitedByUserId,
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

/** Count admins (regardless of disabled state). */
export function countAdmins(): number {
	const db = getDb();
	return db.select({ id: users.id }).from(users).where(eq(users.role, 'admin')).all().length;
}

/**
 * Upgrade-recovery: an existing single-user DB predating the multi-user work
 * gets the new `role` column defaulted to 'user' (the deliberate fail-safe so
 * a migration can't silently mint admins), which leaves it with ZERO admins —
 * and `/setup` is structurally closed once any user exists, so there'd be no
 * in-app way to mint one. Run once on the first authenticated request (see
 * hooks.server.ts): if there are users but no admin at all, promote the
 * earliest-created user (the original operator).
 *
 * Idempotent and cheap (two counts): a no-op on fresh installs (no users yet —
 * the setup wizard makes its user an admin) and on any DB that already has an
 * admin. It can't misfire in normal multi-user operation either: the admin API
 * refuses to remove the last admin, so a live zero-admin state is only
 * reachable through this very migration. Returns the promoted user id, or null
 * when nothing was done.
 */
export function ensureAdminBootstrap(): string | null {
	if (countUsers() === 0) return null;
	if (countAdmins() > 0) return null;
	const db = getDb();
	const earliest = db
		.select({ id: users.id })
		.from(users)
		.orderBy(asc(users.createdAt))
		.limit(1)
		.get();
	if (!earliest) return null;
	db.update(users).set({ role: 'admin' }).where(eq(users.id, earliest.id)).run();
	console.warn(
		`[auth] No admin account found on boot; promoted earliest user (${earliest.id}) to admin ` +
			`— single-user → multi-user upgrade recovery.`,
	);
	return earliest.id;
}

/** Read a user's role (used where the session context isn't to hand). */
export function getUserRole(userId: string): UserRole | null {
	const db = getDb();
	const row = db.select({ role: users.role }).from(users).where(eq(users.id, userId)).get();
	return row?.role ?? null;
}

/** The user's stored conversation-topics overview (the map injected into the
 *  persona prompt), or null if never built. */
export function getConversationOverview(userId: string): string | null {
	const db = getDb();
	const row = db
		.select({ overview: users.conversationOverview })
		.from(users)
		.where(eq(users.id, userId))
		.get();
	return row?.overview ?? null;
}

/** The overview plus its last-built timestamp, for the settings transparency view.
 *  (The persona path uses `getConversationOverview` — it only needs the text.) */
export function getConversationOverviewMeta(userId: string): {
	overview: string | null;
	updatedAt: number | null;
} {
	const db = getDb();
	const row = db
		.select({ overview: users.conversationOverview, updatedAt: users.overviewUpdatedAt })
		.from(users)
		.where(eq(users.id, userId))
		.get();
	return { overview: row?.overview ?? null, updatedAt: row?.updatedAt ?? null };
}

/** Store a rebuilt overview + advance its watermark (the summary worker's overview
 *  phase). */
export function setConversationOverview(userId: string, overview: string, updatedAt: number): void {
	const db = getDb();
	db.update(users)
		.set({ conversationOverview: overview, overviewUpdatedAt: updatedAt })
		.where(eq(users.id, userId))
		.run();
}

/**
 * Reconcile a user's overview after one of their conversations is deleted. The
 * overview is rebuilt-from-all only when a summary changes, and a hard delete
 * doesn't touch any remaining `summarized_at` — so without this a deleted
 * conversation's topics would linger in the injected overview until some unrelated
 * re-summarization (or forever, once the last summarized conversation is gone).
 *
 * If no summarized conversations remain → clear the overview (it describes only
 * gone content, and the watermark query would never re-select the user). Otherwise
 * keep the current text but null the watermark so the next sweep rebuilds it
 * without the deleted conversation. Caller passes its `tx` (this runs inside
 * `deleteConversation`'s transaction). Only call when the deleted conversation
 * actually had a summary — an unsummarized one never affected the overview.
 */
export function reconcileOverviewAfterConversationDelete(userId: string, tx?: Tx): void {
	const db = tx ?? getDb();
	const remaining = db
		.select({ n: count() })
		.from(conversations)
		.where(and(eq(conversations.userId, userId), isNotNull(conversations.summary)))
		.get();
	if (!remaining || remaining.n === 0) {
		db.update(users)
			.set({ conversationOverview: null, overviewUpdatedAt: null })
			.where(eq(users.id, userId))
			.run();
	} else {
		db.update(users).set({ overviewUpdatedAt: null }).where(eq(users.id, userId)).run();
	}
}

/**
 * Users whose conversation overview should be rebuilt this sweep: those with at
 * least one summarized conversation whose store changed since the overview was
 * last built (`overview_updated_at` null, or a conversation `summarized_at` is
 * newer). A settled user returns nothing. Cross-user (background job); mirrors
 * `listUsersNeedingDreaming`.
 */
export function listUsersNeedingOverview(): string[] {
	const db = getDb();
	const rows = db
		.select({ userId: conversations.userId })
		.from(conversations)
		.innerJoin(users, eq(users.id, conversations.userId))
		.where(isNotNull(conversations.summary))
		.groupBy(conversations.userId)
		.having(
			sql`${users.overviewUpdatedAt} is null or max(${conversations.summarizedAt}) > ${users.overviewUpdatedAt}`,
		)
		.all();
	return rows.map((r) => r.userId);
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
