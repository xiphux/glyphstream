/**
 * Seed helpers for DB-backed tests. Insert minimum-viable rows so
 * downstream queries have valid foreign keys to point at.
 */

import { randomUUID } from 'node:crypto';
import { activeTestDb } from './test-db';
import { oauthAccounts, users } from '../../../src/lib/server/db/schema';

export interface SeededUser {
	id: string;
	displayName: string | null;
	email: string | null;
}

let nextUserCounter = 1000;

export function seedUser(overrides: Partial<SeededUser> = {}): SeededUser {
	const id = overrides.id ?? randomUUID();
	const counter = nextUserCounter++;
	const displayName = 'displayName' in overrides ? overrides.displayName! : `User ${counter}`;
	const email = 'email' in overrides ? overrides.email! : `user${counter}@example.test`;
	activeTestDb()
		.insert(users)
		.values({
			id,
			email,
			displayName,
			createdAt: Date.now(),
			lastLoginAt: null,
			disabledAt: null,
		})
		.run();
	return { id, displayName, email };
}

export interface SeededOAuthAccount {
	id: string;
	userId: string;
	provider: string;
	externalId: string;
	externalUsername: string | null;
}

/**
 * Optionally bind a GitHub-style OAuth identity to a seeded user. Used
 * by tests that exercise login-via-OAuth paths or want the existing
 * operator's bootstrap shape (every user pre-PR-1 had exactly one
 * github oauth_accounts row).
 */
export function seedOAuthAccount(
	userId: string,
	overrides: Partial<Omit<SeededOAuthAccount, 'userId'>> = {},
): SeededOAuthAccount {
	const id = overrides.id ?? randomUUID();
	const provider = overrides.provider ?? 'github';
	const externalId = overrides.externalId ?? String(nextUserCounter++);
	const externalUsername =
		'externalUsername' in overrides ? overrides.externalUsername! : `user${externalId}`;
	activeTestDb()
		.insert(oauthAccounts)
		.values({
			id,
			userId,
			provider,
			externalId,
			externalUsername,
			externalEmail: null,
			createdAt: Date.now(),
			lastSyncedAt: null,
		})
		.run();
	return { id, userId, provider, externalId, externalUsername };
}
