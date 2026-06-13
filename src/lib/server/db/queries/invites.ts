/**
 * Invite-token queries for admin-controlled onboarding. An admin mints an
 * invite (the raw token is returned ONCE and embedded in a /join/<token>
 * URL); the invitee redeems it by completing GitHub OAuth or passkey
 * registration, which creates their user row in the same transaction that
 * consumes the invite.
 *
 * Only the SHA-256 hash of the token is stored — the raw token never lands
 * in the DB, mirroring the session module's hash-the-token pattern. A DB
 * read therefore can't reconstruct a usable invite.
 */
import { and, desc, eq, isNull } from 'drizzle-orm';
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
			usedAt: null,
			usedByUserId: null,
		})
		.run();
	return { id, token, expiresAt };
}

export interface ValidInvite {
	id: string;
	role: UserRole;
}

/**
 * Resolve a raw token to an invite that is still redeemable — exists,
 * unused, and unexpired. Returns null otherwise (the join flow maps null to
 * a "this invite link is invalid or expired" page). `now` is injectable for
 * tests.
 */
export function findValidInvite(rawToken: string, now: number = Date.now()): ValidInvite | null {
	if (!rawToken) return null;
	const db = getDb();
	const row = db
		.select({
			id: invites.id,
			role: invites.role,
			expiresAt: invites.expiresAt,
			usedAt: invites.usedAt,
		})
		.from(invites)
		.where(eq(invites.tokenHash, hashInviteToken(rawToken)))
		.get();
	if (!row) return null;
	if (row.usedAt !== null) return null;
	if (row.expiresAt <= now) return null;
	return { id: row.id, role: row.role };
}

/**
 * Mark an invite redeemed. The `WHERE used_at IS NULL` clause makes this a
 * single-use atomic claim: a double-submit race that both passed
 * `findValidInvite` will see exactly one UPDATE match a row — the loser gets
 * `false` and the caller rolls back its user insert. Pass `tx` so the
 * consume and the `createUser` insert commit together.
 */
export function consumeInvite(inviteId: string, usedByUserId: string, tx?: Tx): boolean {
	const exec = tx ?? getDb();
	const res = exec
		.update(invites)
		.set({ usedAt: Date.now(), usedByUserId })
		.where(and(eq(invites.id, inviteId), isNull(invites.usedAt)))
		.run();
	return res.changes > 0;
}

export interface InviteSummary {
	id: string;
	role: UserRole;
	createdByUserId: string;
	createdAt: number;
	expiresAt: number;
	usedAt: number | null;
	usedByUserId: string | null;
}

/** All invites, newest first — for the admin UI's invite list. */
export function listInvites(): InviteSummary[] {
	const db = getDb();
	return db
		.select({
			id: invites.id,
			role: invites.role,
			createdByUserId: invites.createdByUserId,
			createdAt: invites.createdAt,
			expiresAt: invites.expiresAt,
			usedAt: invites.usedAt,
			usedByUserId: invites.usedByUserId,
		})
		.from(invites)
		.orderBy(desc(invites.createdAt))
		.all();
}

/** Delete an invite by id (admin revoke of an unredeemed invite). */
export function deleteInvite(id: string): boolean {
	const db = getDb();
	const res = db.delete(invites).where(eq(invites.id, id)).run();
	return res.changes > 0;
}
