/**
 * Tests for the media → data-URL conversion used by the vision-chat
 * inlining path. Ownership and tombstone guards are the security-
 * relevant bits — passing the wrong userId or a deleted media id
 * must not leak the bytes.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createTestDb, closeTestDb, type TestDB } from './_helpers/test-db';
import { seedUser } from './_helpers/seed';

const mocks = vi.hoisted(() => ({
	testDb: null as unknown as TestDB,
	mediaDir: '',
}));
vi.mock('$lib/server/db/client', () => ({
	getDb: () => mocks.testDb,
	closeDb: () => {},
}));
vi.mock('$lib/server/env', () => ({
	mediaDir: () => mocks.mediaDir,
	// Anything else the imported module pulls transitively — none of the
	// data-url path needs them, but defensive stubs avoid unrelated env
	// reads tripping up the mock.
	dbPath: () => './data/glyphstream.db',
	configPath: () => './config.toml',
	logLevel: () => 'info',
}));

import { loadMediaBytes, mediaIdToDataUrl } from '$lib/server/media/data-url';
import { insertMedia } from '$lib/server/db/queries/media';
import { media } from '$lib/server/db/schema';
import { eq } from 'drizzle-orm';

function writeMediaFile(storagePath: string, bytes: Buffer): void {
	const abs = resolve(mocks.mediaDir, storagePath);
	mkdirSync(dirname(abs), { recursive: true });
	writeFileSync(abs, bytes);
}

beforeEach(() => {
	mocks.testDb = createTestDb();
	mocks.mediaDir = mkdtempSync(join(tmpdir(), 'gs-media-test-'));
});

afterEach(() => {
	closeTestDb();
	rmSync(mocks.mediaDir, { recursive: true, force: true });
});

describe('loadMediaBytes', () => {
	it('returns bytes + content type + kind for the owner', async () => {
		const u = seedUser();
		const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47]); // PNG magic
		const { id } = insertMedia({
			userId: u.id,
			storagePath: 'ab/cd/test.png',
			contentType: 'image/png',
			byteSize: bytes.length,
			kind: 'image',
			sourceEndpointId: null,
			sourceModel: null,
			promptExcerpt: null,
		});
		writeMediaFile('ab/cd/test.png', bytes);

		const result = await loadMediaBytes(id, u.id);
		expect(result.bytes.equals(bytes)).toBe(true);
		expect(result.contentType).toBe('image/png');
		expect(result.kind).toBe('image');
	});

	it('throws when the userId does not own the media', async () => {
		const owner = seedUser();
		const attacker = seedUser();
		const { id } = insertMedia({
			userId: owner.id,
			storagePath: 'aa/bb/owned.png',
			contentType: 'image/png',
			byteSize: 4,
			kind: 'image',
			sourceEndpointId: null,
			sourceModel: null,
			promptExcerpt: null,
		});
		// Even though the file exists on disk, ownership check fails first
		// — and crucially before the readFile, so we don't leak existence.
		writeMediaFile('aa/bb/owned.png', Buffer.from('PNG'));
		await expect(loadMediaBytes(id, attacker.id)).rejects.toThrow(/not found/i);
	});

	it('throws "not found" for an unknown media id', async () => {
		const u = seedUser();
		await expect(loadMediaBytes('does-not-exist', u.id)).rejects.toThrow(/not found/i);
	});

	it('throws "has been deleted" when the row is hard-deleted', async () => {
		const u = seedUser();
		const { id } = insertMedia({
			userId: u.id,
			storagePath: 'aa/bb/zapped.png',
			contentType: 'image/png',
			byteSize: 4,
			kind: 'image',
			sourceEndpointId: null,
			sourceModel: null,
			promptExcerpt: null,
		});
		writeMediaFile('aa/bb/zapped.png', Buffer.from('PNG'));
		mocks.testDb.update(media).set({ hardDeletedAt: Date.now() }).where(eq(media.id, id)).run();
		await expect(loadMediaBytes(id, u.id)).rejects.toThrow(/deleted/i);
	});

	it('propagates the underlying fs error when the file is missing on disk', async () => {
		// DB row says the file exists; disk says no — surfaces as a real
		// ENOENT so callers know the source of the problem rather than
		// seeing an opaque "not found" that they'd otherwise interpret as
		// "user passed wrong id."
		const u = seedUser();
		const { id } = insertMedia({
			userId: u.id,
			storagePath: 'ab/cd/missing.png',
			contentType: 'image/png',
			byteSize: 0,
			kind: 'image',
			sourceEndpointId: null,
			sourceModel: null,
			promptExcerpt: null,
		});
		await expect(loadMediaBytes(id, u.id)).rejects.toThrow(/ENOENT/);
	});
});

describe('mediaIdToDataUrl', () => {
	it('builds a base64 data URL with the content type from the row', async () => {
		const u = seedUser();
		const bytes = Buffer.from('Hello, world!');
		const { id } = insertMedia({
			userId: u.id,
			storagePath: 'aa/bb/hello.bin',
			contentType: 'application/octet-stream',
			byteSize: bytes.length,
			kind: 'image',
			sourceEndpointId: null,
			sourceModel: null,
			promptExcerpt: null,
		});
		writeMediaFile('aa/bb/hello.bin', bytes);

		const url = await mediaIdToDataUrl(id, u.id);
		expect(url).toBe(`data:application/octet-stream;base64,${bytes.toString('base64')}`);
	});

	it('inherits the ownership guard from loadMediaBytes', async () => {
		const owner = seedUser();
		const attacker = seedUser();
		const { id } = insertMedia({
			userId: owner.id,
			storagePath: 'aa/bb/secret.png',
			contentType: 'image/png',
			byteSize: 1,
			kind: 'image',
			sourceEndpointId: null,
			sourceModel: null,
			promptExcerpt: null,
		});
		writeMediaFile('aa/bb/secret.png', Buffer.from([0x00]));
		await expect(mediaIdToDataUrl(id, attacker.id)).rejects.toThrow(/not found/i);
	});
});
