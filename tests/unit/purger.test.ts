import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdirSync } from 'node:fs';
import { createTestDb, closeTestDb, type TestDB } from './_helpers/test-db';
import { seedUser } from './_helpers/seed';

// Mock both the DB client and the env so the purger sees an in-memory
// DB and a temp media directory we control.
const mocks = vi.hoisted(() => ({
	testDb: null as unknown as TestDB,
	mediaDir: '' as string,
	graceMs: 0
}));

vi.mock('$lib/server/db/client', () => ({
	getDb: () => mocks.testDb,
	closeDb: () => {}
}));

vi.mock('$lib/server/env', () => ({
	mediaDir: () => mocks.mediaDir,
	mediaGracePeriodDays: () => mocks.graceMs / 86_400_000,
	mediaPurgeIntervalSeconds: () => 3600,
	dbPath: () => ':memory:',
	logLevel: () => 'info',
	configPath: () => '/tmp/nope.toml',
	authSecret: () => 'test-secret',
	githubClientId: () => 'test',
	githubClientSecret: () => 'test',
	publicBaseUrl: () => 'http://localhost',
	allowedGithubUserIdsRaw: () => ''
}));

import { runPurgeSweep } from '$lib/server/media/purger';
import { insertMedia } from '$lib/server/db/queries/media';
import { media } from '$lib/server/db/schema';

let tmpDirs: string[] = [];

beforeEach(() => {
	mocks.testDb = createTestDb();
	const dir = mkdtempSync(resolve(tmpdir(), 'gs-purger-'));
	mocks.mediaDir = dir;
	tmpDirs.push(dir);
	mocks.graceMs = 7 * 86_400_000; // default 7 days
});

afterEach(() => {
	closeTestDb();
	for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
	tmpDirs = [];
});

function writeMediaFile(storagePath: string, content = 'fake bytes'): string {
	const abs = resolve(mocks.mediaDir, storagePath);
	mkdirSync(dirname(abs), { recursive: true });
	writeFileSync(abs, content);
	return abs;
}

describe('runPurgeSweep', () => {
	it('does nothing when there are no candidates', async () => {
		const r = await runPurgeSweep();
		expect(r.stamped).toBe(0);
		expect(r.hardDeleted).toBe(0);
	});

	it('stamps zero-ref orphans (no unreferencedSince yet)', async () => {
		const u = seedUser();
		const { id } = insertMedia({
			userId: u.id,
			storagePath: 'aa/bb/x.png',
			contentType: 'image/png',
			byteSize: 10,
			kind: 'image',
			sourceEndpointId: null,
			sourceModel: null,
			promptExcerpt: null
		});
		const r = await runPurgeSweep();
		expect(r.stamped).toBeGreaterThanOrEqual(1);
		const row = mocks.testDb.select().from(media).where(eq(media.id, id)).get();
		expect(row?.unreferencedSince).not.toBeNull();
	});

	it('hard-deletes file + row when unreferencedSince is past the grace window', async () => {
		const u = seedUser();
		const storagePath = 'aa/bb/old.png';
		const abs = writeMediaFile(storagePath);
		const { id } = insertMedia({
			userId: u.id,
			storagePath,
			contentType: 'image/png',
			byteSize: 10,
			kind: 'image',
			sourceEndpointId: null,
			sourceModel: null,
			promptExcerpt: null
		});
		// Stamp it as long-unreferenced (way past the 7d default).
		const longAgo = Date.now() - 30 * 86_400_000;
		mocks.testDb.update(media).set({ unreferencedSince: longAgo }).where(eq(media.id, id)).run();
		expect(existsSync(abs)).toBe(true);

		const r = await runPurgeSweep();
		expect(r.hardDeleted).toBeGreaterThanOrEqual(1);
		expect(existsSync(abs)).toBe(false);
		const row = mocks.testDb.select().from(media).where(eq(media.id, id)).get();
		expect(row?.hardDeletedAt).not.toBeNull();
	});

	it('does NOT hard-delete rows still inside the grace window', async () => {
		const u = seedUser();
		const storagePath = 'aa/bb/recent.png';
		const abs = writeMediaFile(storagePath);
		const { id } = insertMedia({
			userId: u.id,
			storagePath,
			contentType: 'image/png',
			byteSize: 10,
			kind: 'image',
			sourceEndpointId: null,
			sourceModel: null,
			promptExcerpt: null
		});
		// Stamp as unreferenced 1 minute ago — grace is 7 days so this stays.
		mocks.testDb
			.update(media)
			.set({ unreferencedSince: Date.now() - 60_000 })
			.where(eq(media.id, id))
			.run();

		const r = await runPurgeSweep();
		expect(r.hardDeleted).toBe(0);
		expect(existsSync(abs)).toBe(true);
		const row = mocks.testDb.select().from(media).where(eq(media.id, id)).get();
		expect(row?.hardDeletedAt).toBeNull();
	});

	it('survives missing files (best-effort delete)', async () => {
		const u = seedUser();
		// File was already removed manually; row says it should still exist.
		const { id } = insertMedia({
			userId: u.id,
			storagePath: 'aa/bb/missing.png',
			contentType: 'image/png',
			byteSize: 10,
			kind: 'image',
			sourceEndpointId: null,
			sourceModel: null,
			promptExcerpt: null
		});
		mocks.testDb
			.update(media)
			.set({ unreferencedSince: 1 }) // way past any grace
			.where(eq(media.id, id))
			.run();
		const r = await runPurgeSweep();
		// Should still mark hard-deleted; missing file is fine (logged, not thrown).
		expect(r.hardDeleted).toBeGreaterThanOrEqual(1);
	});
});
