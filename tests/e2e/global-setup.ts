/**
 * Playwright global setup — runs once before any tests.
 *
 * Opens the test DB at the path that the dev server (started by
 * Playwright's webServer) will use, applies migrations, inserts a test
 * user + session, and writes a storage-state file containing the
 * session cookie so every test starts already-authenticated.
 *
 * This skips the GitHub OAuth round-trip entirely. Real OAuth flow
 * isn't worth running in every CI run (would need a test GitHub app
 * or HTTP mocking); cookie-injection covers "is the app behaving
 * correctly when authenticated", which is the actually-useful coverage.
 */

import { mkdirSync, existsSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import * as schema from '../../src/lib/server/db/schema';

const DATA_DIR = resolve('./tests/.e2e-data');
const DB_PATH = resolve(DATA_DIR, 'test.db');
const MEDIA_DIR = resolve(DATA_DIR, 'media');
const STORAGE_STATE_PATH = resolve(DATA_DIR, 'auth.json');

export const TEST_USER = {
	id: '00000000-0000-0000-0000-000000000001',
	githubUserId: 99999,
	githubUsername: 'e2e-tester',
	displayName: 'E2E Tester',
};

export default async function globalSetup() {
	// Wipe and recreate the per-run data dir so tests start from a clean
	// slate every time. Avoids cross-run state leaking (e.g. conversations
	// from yesterday's run showing up in the sidebar).
	if (existsSync(DATA_DIR)) rmSync(DATA_DIR, { recursive: true, force: true });
	mkdirSync(DATA_DIR, { recursive: true });
	mkdirSync(MEDIA_DIR, { recursive: true });

	// Open + migrate the same DB the dev server will subsequently open.
	const sqlite = new Database(DB_PATH);
	sqlite.pragma('journal_mode = WAL');
	sqlite.pragma('foreign_keys = ON');
	const db = drizzle(sqlite, { schema });
	migrate(db, { migrationsFolder: resolve('./drizzle') });

	// Seed the test user.
	db.insert(schema.users)
		.values({
			id: TEST_USER.id,
			githubUserId: TEST_USER.githubUserId,
			githubUsername: TEST_USER.githubUsername,
			email: 'e2e@example.test',
			displayName: TEST_USER.displayName,
			createdAt: Date.now(),
			lastLoginAt: Date.now(),
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
