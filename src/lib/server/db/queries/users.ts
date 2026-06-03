import { eq } from 'drizzle-orm';
import { generateId } from '../../util/id';
import { getDb } from '../client';
import { users } from '../schema';

export interface UpsertUserInput {
	githubUserId: number;
	githubUsername: string;
	email: string | null;
	displayName: string | null;
}

/**
 * Upsert a user row keyed on github_user_id. Updates username/email/display
 * on every login (those fields can change upstream) and bumps last_login_at.
 * Returns the user's internal id.
 */
export function upsertUserByGithub(input: UpsertUserInput): string {
	const db = getDb();
	const now = Date.now();

	const existing = db
		.select({ id: users.id })
		.from(users)
		.where(eq(users.githubUserId, input.githubUserId))
		.get();

	if (existing) {
		db.update(users)
			.set({
				githubUsername: input.githubUsername,
				email: input.email,
				displayName: input.displayName,
				lastLoginAt: now,
			})
			.where(eq(users.id, existing.id))
			.run();
		return existing.id;
	}

	const id = generateId();
	db.insert(users)
		.values({
			id,
			githubUserId: input.githubUserId,
			githubUsername: input.githubUsername,
			email: input.email,
			displayName: input.displayName,
			createdAt: now,
			lastLoginAt: now,
		})
		.run();
	return id;
}

/**
 * Bump `last_login_at` without touching any other field. Used by the
 * passkey login path — there's no GitHub profile to upsert from, but
 * the "when did this user last sign in" stat should still update.
 */
export function bumpUserLastLogin(userId: string): void {
	const db = getDb();
	db.update(users).set({ lastLoginAt: Date.now() }).where(eq(users.id, userId)).run();
}
