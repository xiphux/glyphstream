/**
 * Shared plumbing for the invite-redemption (`/join/<token>`) flow — the
 * multi-user counterpart of the first-run `/setup` wizard. Where setup is
 * gated by `setupGate()` (user count must be zero) and mints the admin via
 * `createInitialUser`, join is gated by a valid invite token and mints a
 * normal account via `createUser({ role })`, consuming the invite in the
 * same transaction.
 *
 * Cookie-name constants live here (not in the `+server.ts` route files)
 * because SvelteKit validates route-file exports against a fixed list —
 * route files can't share named constants. Same reasoning as
 * `setup.ts`'s carry-cookie constants.
 */
import { getDb } from '../db/client';
import { createUser, type UserRole } from '../db/queries/users';
import { consumeInvite } from '../db/queries/invites';
import { addOAuthAccount } from '../db/queries/oauth-accounts';
import { insertCredential, type InsertPasskeyInput } from '../db/queries/passkey';

/** Signed carry cookie holding the invite token + typed name/email across
 *  GitHub's OAuth round-trip (which lands on the shared callback). */
export const JOIN_GITHUB_CARRY_COOKIE = 'glyphstream_join_github_carry';

/** Signed carry cookie holding the prospective userId + invite token +
 *  name/email across the passkey registration ceremony. */
export const JOIN_PASSKEY_CARRY_COOKIE = 'glyphstream_join_passkey_carry';

/**
 * Thrown when the invite was redeemed by a racing request between the
 * gate check and the final consume. The enclosing transaction rolls back,
 * so no half-created user/credential is left behind. Routes map this to a
 * "this invite was already used" error.
 */
export class InviteConsumedError extends Error {}

/**
 * Create a user from a redeemed invite and bind a GitHub identity, marking
 * the invite used — all in one transaction. `consumeInvite`'s conditional
 * UPDATE is the single-use guard: if a parallel redemption already used the
 * invite, it matches zero rows and we throw to roll the whole thing back.
 */
export function finalizeOAuthJoin(args: {
	inviteId: string;
	role: UserRole;
	displayName: string;
	email: string | null;
	oauth: {
		provider: string;
		externalId: string;
		externalUsername: string | null;
		externalEmail: string | null;
	};
}): string {
	const db = getDb();
	return db.transaction((tx) => {
		const userId = createUser(
			{ displayName: args.displayName, email: args.email, role: args.role },
			tx,
		);
		addOAuthAccount({ userId, ...args.oauth }, tx);
		if (!consumeInvite(args.inviteId, userId, tx)) {
			throw new InviteConsumedError('invite already redeemed');
		}
		return userId;
	});
}

/**
 * Create a user from a redeemed invite and bind a passkey credential,
 * marking the invite used — all in one transaction. `userId` is the
 * prospective id the authenticator already recorded as the userHandle, so
 * the credential's `userId` and the new `users.id` match.
 */
export function finalizePasskeyJoin(args: {
	inviteId: string;
	role: UserRole;
	userId: string;
	displayName: string;
	email: string | null;
	credential: Omit<InsertPasskeyInput, 'userId'>;
}): string {
	const db = getDb();
	return db.transaction((tx) => {
		const userId = createUser(
			{ id: args.userId, displayName: args.displayName, email: args.email, role: args.role },
			tx,
		);
		insertCredential({ userId, ...args.credential }, tx);
		if (!consumeInvite(args.inviteId, userId, tx)) {
			throw new InviteConsumedError('invite already redeemed');
		}
		return userId;
	});
}
