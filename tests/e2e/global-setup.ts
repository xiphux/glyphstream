/**
 * Playwright global setup — runs once before any tests.
 *
 * Opens the test DB at the path that the dev server (started by
 * Playwright's webServer) will use, applies migrations, inserts a test
 * user + their GitHub OAuth binding + a session, and writes a
 * storage-state file containing the session cookie so every test
 * starts already-authenticated.
 *
 * This skips the GitHub OAuth round-trip entirely. Real OAuth flow
 * isn't worth running in every CI run (would need a test GitHub app
 * or HTTP mocking); cookie-injection covers "is the app behaving
 * correctly when authenticated", which is the actually-useful coverage.
 *
 * The OAuth binding row matters because post-PR-1 a user without any
 * bound provider is treated as a passkey-only operator — fine for
 * already-authenticated tests, but if any test exercises the GitHub
 * callback's "match an existing binding" path it needs this row.
 */

import { mkdirSync, existsSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { drizzle } from 'drizzle-orm/node-sqlite';
import { migrate } from 'drizzle-orm/node-sqlite/migrator';
import * as schema from '../../src/lib/server/db/schema';

const DATA_DIR = resolve('./tests/.e2e-data');
const DB_PATH = resolve(DATA_DIR, 'test.db');
const MEDIA_DIR = resolve(DATA_DIR, 'media');
const STORAGE_STATE_PATH = resolve(DATA_DIR, 'auth.json');

export const TEST_USER = {
	id: '00000000-0000-0000-0000-000000000001',
	displayName: 'E2E Tester',
	email: 'e2e@example.test',
};

const TEST_OAUTH_ACCOUNT = {
	id: '00000000-0000-0000-0000-000000000002',
	provider: 'github' as const,
	externalId: '99999',
	externalUsername: 'e2e-tester',
};

export default async function globalSetup() {
	// Wipe and recreate the per-run data dir so tests start from a clean
	// slate every time. Avoids cross-run state leaking (e.g. conversations
	// from yesterday's run showing up in the sidebar).
	if (existsSync(DATA_DIR)) rmSync(DATA_DIR, { recursive: true, force: true });
	mkdirSync(DATA_DIR, { recursive: true });
	mkdirSync(MEDIA_DIR, { recursive: true });

	// Open + migrate the same DB the dev server will subsequently open.
	const sqlite = new DatabaseSync(DB_PATH);
	sqlite.exec('PRAGMA journal_mode = WAL');
	sqlite.exec('PRAGMA foreign_keys = ON');
	const db = drizzle({ client: sqlite, schema });
	migrate(db, { migrationsFolder: resolve('./drizzle') });

	// Seed the test user + the OAuth binding that mirrors the operator's
	// post-PR-1 shape (every user is bootstrapped with at least one
	// linked provider; passkey-only is reachable after PR 2's wizard).
	db.insert(schema.users)
		.values({
			id: TEST_USER.id,
			email: TEST_USER.email,
			displayName: TEST_USER.displayName,
			// The bootstrap operator is an admin (the setup-wizard user's role),
			// so authenticated e2e tests can reach the /settings/admin surface.
			role: 'admin',
			createdAt: Date.now(),
			lastLoginAt: Date.now(),
			disabledAt: null,
		})
		.run();
	db.insert(schema.oauthAccounts)
		.values({
			id: TEST_OAUTH_ACCOUNT.id,
			userId: TEST_USER.id,
			provider: TEST_OAUTH_ACCOUNT.provider,
			externalId: TEST_OAUTH_ACCOUNT.externalId,
			externalUsername: TEST_OAUTH_ACCOUNT.externalUsername,
			externalEmail: TEST_USER.email,
			createdAt: Date.now(),
			lastSyncedAt: Date.now(),
		})
		.run();

	// Mint a session: random token in cookie, sha256 of token in DB.
	// Same shape session.ts uses in production.
	const token = randomBytes(20).toString('base64url');
	const sessionId = createHash('sha256').update(token).digest('hex');
	const expiresAt = Date.now() + 30 * 24 * 60 * 60 * 1000; // 30 days
	db.insert(schema.sessions).values({ id: sessionId, userId: TEST_USER.id, expiresAt }).run();

	sqlite.close();

	// Write Playwright's storageState file. The cookie matches the format
	// readSessionCookie() expects, so the SvelteKit hooks.server.ts will
	// resolve it to a populated locals.user on every request.
	const storageState = {
		cookies: [
			{
				name: 'glyphstream_session',
				value: token,
				domain: 'localhost',
				path: '/',
				expires: expiresAt / 1000, // Playwright wants seconds since epoch
				httpOnly: true,
				secure: false,
				sameSite: 'Lax' as const,
			},
		],
		origins: [],
	};
	writeFileSync(STORAGE_STATE_PATH, JSON.stringify(storageState, null, 2));
}
