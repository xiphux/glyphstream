/**
 * OAuth provider bindings. One row per (provider, external_id) pair;
 * `findUserByOAuth` is the primary login lookup. Binding is *deliberate*
 * — the OAuth callback never auto-creates a row. New bindings come
 * either from PR 2's `/setup` wizard (first user + first binding,
 * atomically) or from the Settings → Security "Link …" flow (existing
 * session calls `addOAuthAccount` directly).
 *
 * `disabledAt` is read through the `users` join on every login so the
 * single revocation column is the only source of truth — no per-row
 * mirror to keep in sync.
 */

import { and, asc, eq } from 'drizzle-orm';
import { generateId } from '../../util/id';
import { getDb, type Tx } from '../client';
import { oauthAccounts, users } from '../schema';

export interface OAuthAccountRow {
	id: string;
	userId: string;
	provider: string;
	externalId: string;
	externalUsername: string | null;
	externalEmail: string | null;
	createdAt: number;
	lastSyncedAt: number | null;
}

/** UI-safe projection — omits the internal row id and last-synced
 *  timestamp; everything the settings page actually needs to render. */
export interface OAuthAccountSummary {
	provider: string;
	externalId: string;
	externalUsername: string | null;
	externalEmail: string | null;
	createdAt: number;
}

export interface AddOAuthAccountInput {
	userId: string;
	provider: string;
	externalId: string;
	externalUsername: string | null;
	externalEmail: string | null;
}

/** Login-side lookup: returns the owning user's id + revocation flag.
 *  `null` when no binding matches. The join through to `users` keeps
 *  the per-login disabled check in a single round-trip. */
export function findUserByOAuth(
	provider: string,
	externalId: string,
): { userId: string; disabledAt: number | null } | null {
	const db = getDb();
	const row = db
		.select({ userId: users.id, disabledAt: users.disabledAt })
		.from(oauthAccounts)
		.innerJoin(users, eq(oauthAccounts.userId, users.id))
		.where(and(eq(oauthAccounts.provider, provider), eq(oauthAccounts.externalId, externalId)))
		.get();
	return row ?? null;
}

/** UI list. Stable order: oldest binding first so the operator's
 *  bootstrap provider naturally renders before any later links. */
export function listOAuthAccountsForUser(userId: string): OAuthAccountSummary[] {
	const db = getDb();
	return db
		.select({
			provider: oauthAccounts.provider,
			externalId: oauthAccounts.externalId,
			externalUsername: oauthAccounts.externalUsername,
			externalEmail: oauthAccounts.externalEmail,
			createdAt: oauthAccounts.createdAt,
		})
		.from(oauthAccounts)
		.where(eq(oauthAccounts.userId, userId))
		.orderBy(asc(oauthAccounts.createdAt))
		.all();
}

/** Bind a provider account to a user. Throws on UNIQUE conflict
 *  (provider already bound somewhere — possibly to this user, possibly
 *  to a different one); routes translate that to 409. */
export function addOAuthAccount(input: AddOAuthAccountInput, tx?: Tx): void {
	const exec = tx ?? getDb();
	exec
		.insert(oauthAccounts)
		.values({
			id: generateId(),
			userId: input.userId,
			provider: input.provider,
			externalId: input.externalId,
			externalUsername: input.externalUsername,
			externalEmail: input.externalEmail,
			createdAt: Date.now(),
			lastSyncedAt: Date.now(),
		})
		.run();
}

/** Refresh the provider-supplied profile snapshot on every successful
 *  login. Updates only the mutable fields plus last_synced_at; leaves
 *  the binding row id, user_id, provider, and external_id untouched. */
export function touchOAuthAccount(
	provider: string,
	externalId: string,
	patch: { externalUsername: string | null; externalEmail: string | null },
): void {
	const db = getDb();
	db.update(oauthAccounts)
		.set({
			externalUsername: patch.externalUsername,
			externalEmail: patch.externalEmail,
			lastSyncedAt: Date.now(),
		})
		.where(and(eq(oauthAccounts.provider, provider), eq(oauthAccounts.externalId, externalId)))
		.run();
}

/** User-scoped unlink — PR 2's settings page calls this. Returns true
 *  iff a row matched (i.e. the binding existed on this user). */
export function deleteOAuthAccount(userId: string, provider: string): boolean {
	const db = getDb();
	const result = db
		.delete(oauthAccounts)
		.where(and(eq(oauthAccounts.userId, userId), eq(oauthAccounts.provider, provider)))
		.run();
	return result.changes > 0;
}

/** PR 2's last-method guard: combined with passkey count, refuses an
 *  unlink that would leave the user with no way to sign in. */
export function countOAuthAccountsForUser(userId: string): number {
	const db = getDb();
	const rows = db
		.select({ id: oauthAccounts.id })
		.from(oauthAccounts)
		.where(eq(oauthAccounts.userId, userId))
		.all();
	return rows.length;
}
