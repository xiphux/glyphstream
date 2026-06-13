/**
 * Invite-token queries for admin-controlled onboarding. An admin mints an
 * invite (the raw token is returned ONCE and embedded in a /join/<token>
 * URL); the invitee redeems it by completing GitHub OAuth or passkey
 * registration, which creates their user row in the same transaction that
 * DELETES the invite. The one durable fact — which admin issued it — is
 * denormalized onto the new user's `invited_by_user_id`, so the invite row
 * itself is purely transient: every row here is an outstanding invite.
 *
 * Only the SHA-256 hash of the token is stored — the raw token never lands
 * in the DB, mirroring the session module's hash-the-token pattern. A DB
 * read therefore can't reconstruct a usable invite.
 */
import { desc, eq } from 'drizzle-orm';
import { createHash, randomBytes } from 'node:crypto';
import { generateId } from '../../util/id';
import { getDb, type Tx } from '../client';
import { invites } from '../schema';
import type { UserRole } from './users';

/** Hex SHA-256 of a raw invite token — the stored/looked-up form. */
export function hashInviteToken(rawToken: string): string {
	return createHash('sha256').update(rawToken, 'utf8').digest('hex');
}

export interface CreateInviteResult {
	id: string;
	/** The raw token — surfaced to the admin exactly once and embedded in the
	 *  join URL. Never persisted; only its hash is stored. */
	token: string;
	expiresAt: number;
}

/** Mint an invite and return the raw token (the caller shows it once). */
export function createInvite(input: {
	createdByUserId: string;
	role: UserRole;
	ttlMs: number;
}): CreateInviteResult {
	const db = getDb();
	const id = generateId();
	// 32 random bytes → 43-char base64url. High-entropy, URL-safe, no padding.
	const token = randomBytes(32).toString('base64url');
	const now = Date.now();
	const expiresAt = now + input.ttlMs;
	db.insert(invites)
		.values({
			id,
			tokenHash: hashInviteToken(token),
			role: input.role,
			createdByUserId: input.createdByUserId,
			createdAt: now,
			expiresAt,
		})
		.run();
	return { id, token, expiresAt };
}

export interface ValidInvite {
	id: string;
	role: UserRole;
	/** The admin who issued it — denormalized onto the redeeming user. */
	createdByUserId: string;
}

/**
 * Resolve a raw token to a redeemable invite — exists and unexpired. (There's
 * no "used" state: a redeemed invite is deleted.) Returns null otherwise (the
 * join flow maps null to a "this invite link is invalid or expired" page).
 * `now` is injectable for tests.
 */
export function findValidInvite(rawToken: string, now: number = Date.now()): ValidInvite | null {
	if (!rawToken) return null;
	const db = getDb();
	const row = db
		.select({
			id: invites.id,
			role: invites.role,
			createdByUserId: invites.createdByUserId,
			expiresAt: invites.expiresAt,
		})
		.from(invites)
		.where(eq(invites.tokenHash, hashInviteToken(rawToken)))
		.get();
	if (!row) return null;
	if (row.expiresAt <= now) return null;
	return { id: row.id, role: row.role, createdByUserId: row.createdByUserId };
}

/**
 * Redeem (consume) an invite by deleting it. The DELETE is the single-use
 * atomic claim: a double-submit race that both passed `findValidInvite` will
 * see exactly one DELETE match a row — the loser gets `false` and the caller
 * rolls back its user insert. Pass `tx` so the delete and the `createUser`
 * insert commit together.
 */
export function consumeInvite(inviteId: string, tx?: Tx): boolean {
	const exec = tx ?? getDb();
	const res = exec.delete(invites).where(eq(invites.id, inviteId)).run();
	return res.changes > 0;
}

export interface InviteSummary {
	id: string;
	role: UserRole;
	createdByUserId: string;
	createdAt: number;
	expiresAt: number;
}

/** All outstanding invites, newest first — for the admin UI's invite list.
 *  (Redeemed invites are deleted, so every row is pending.) */
export function listInvites(): InviteSummary[] {
	const db = getDb();
	return db
		.select({
			id: invites.id,
			role: invites.role,
			createdByUserId: invites.createdByUserId,
			createdAt: invites.createdAt,
			expiresAt: invites.expiresAt,
		})
		.from(invites)
		.orderBy(desc(invites.createdAt))
		.all();
}

/** Delete an invite by id (admin revoke of an outstanding invite). */
export function deleteInvite(id: string): boolean {
	const db = getDb();
	const res = db.delete(invites).where(eq(invites.id, id)).run();
	return res.changes > 0;
}
