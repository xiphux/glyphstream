/**
 * Seed helpers for DB-backed tests. Insert minimum-viable rows so
 * downstream queries have valid foreign keys to point at.
 */

import { randomUUID } from 'node:crypto';
import { activeTestDb } from './test-db';
import { users } from '../../../src/lib/server/db/schema';

export interface SeededUser {
	id: string;
	githubUserId: number;
	githubUsername: string;
}

let nextGithubId = 1000;

export function seedUser(overrides: Partial<SeededUser> = {}): SeededUser {
	const id = overrides.id ?? randomUUID();
	const githubUserId = overrides.githubUserId ?? nextGithubId++;
	const githubUsername = overrides.githubUsername ?? `user${githubUserId}`;
	activeTestDb()
		.insert(users)
		.values({
			id,
			githubUserId,
			githubUsername,
			email: null,
			displayName: null,
			createdAt: Date.now(),
			lastLoginAt: null
		})
		.run();
	return { id, githubUserId, githubUsername };
}
