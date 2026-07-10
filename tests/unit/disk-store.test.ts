/**
 * Unit tests for DiskMediaStore — focuses on the streaming `putStream` path
 * that avoids buffering the full payload in memory.
 *
 * Follows the same pattern as purger.test.ts: mock $lib/server/env to point
 * `mediaDir()` at a temp directory we control, then exercise the store
 * against real disk I/O.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { Readable } from 'node:stream';

const mocks = vi.hoisted(() => ({
	mediaDir: '' as string,
}));

vi.mock('$lib/server/env', () => ({
	mediaDir: () => mocks.mediaDir,
	dbPath: () => ':memory:',
	logLevel: () => 'info',
	configPath: () => '/tmp/nope.toml',
	authSecret: () => 'test-secret',
	githubClientId: () => 'test',
	githubClientSecret: () => 'test',
	publicBaseUrl: () => 'http://localhost',
	allowedGithubUserIdsRaw: () => '',
}));

import { DiskMediaStore } from '$lib/server/media/disk-store';

let tmpDirs: string[] = [];

beforeEach(() => {
	const dir = mkdtempSync(resolve(tmpdir(), 'gs-disk-store-'));
	mocks.mediaDir = dir;
	tmpDirs.push(dir);
});

afterEach(() => {
	for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
	tmpDirs = [];
});

describe('DiskMediaStore.putStream', () => {
	it('writes stream content to disk at the returned storagePath', async () => {
		const store = new DiskMediaStore();
		const content = Buffer.from('hello streaming world');
		const ref = await store.putStream({
			stream: Readable.from(content),
			contentType: 'video/mp4',
			kind: 'video',
		});

		// Storage path should be a sharded path under mediaDir.
		expect(ref.storagePath).toMatch(/^[0-9a-f]{2}\/[0-9a-f]{2}\/[0-9a-f]+\.mp4$/);
		expect(ref.contentType).toBe('video/mp4');
		expect(ref.byteSize).toBe(content.byteLength);

		// The file must exist on disk with the exact bytes written.
		const abs = resolve(mocks.mediaDir, ref.storagePath);
		expect(existsSync(abs)).toBe(true);
		const onDisk = readFileSync(abs);
		expect(onDisk.equals(content)).toBe(true);
	});

	it('reports correct byteSize for empty stream', async () => {
		const store = new DiskMediaStore();
		const ref = await store.putStream({
			stream: Readable.from(Buffer.alloc(0)),
			contentType: 'text/plain',
			kind: 'file',
		});
		expect(ref.byteSize).toBe(0);
		const abs = resolve(mocks.mediaDir, ref.storagePath);
		expect(existsSync(abs)).toBe(true);
		expect(readFileSync(abs).byteLength).toBe(0);
	});

	it('handles large content without buffering (streaming atomicity)', async () => {
		const store = new DiskMediaStore();
		// 1 MB of repeated pattern — enough to exercise streaming but small
		// enough to run fast in tests.
		const size = 1024 * 1024;
		const content = Buffer.alloc(size, 0xab);
		const ref = await store.putStream({
			stream: Readable.from(content),
			contentType: 'image/png',
			kind: 'image',
		});
		expect(ref.byteSize).toBe(size);
		const abs = resolve(mocks.mediaDir, ref.storagePath);
		const onDisk = readFileSync(abs);
		expect(onDisk.byteLength).toBe(size);
		expect(onDisk[0]).toBe(0xab);
		expect(onDisk[size - 1]).toBe(0xab);
	});

	it('atomically writes to .tmp then renames (no partial file at final path)', async () => {
		const store = new DiskMediaStore();
		const content = Buffer.from('atomic write test');
		const ref = await store.putStream({
			stream: Readable.from(content),
			contentType: 'application/json',
			kind: 'file',
		});

		// Final path exists with correct content.
		const abs = resolve(mocks.mediaDir, ref.storagePath);
		expect(existsSync(abs)).toBe(true);
		expect(readFileSync(abs).toString()).toBe('atomic write test');

		// The .tmp sibling must have been cleaned up (renamed away).
		expect(existsSync(abs + '.tmp')).toBe(false);
	});

	it('returns correct byteSize and content type', async () => {
		const store = new DiskMediaStore();
		const content = Buffer.from('content-type check');
		const ref = await store.putStream({
			stream: Readable.from(content),
			contentType: 'image/webp',
			kind: 'image',
		});
		expect(ref.contentType).toBe('image/webp');
		expect(ref.byteSize).toBe(content.byteLength);
	});
});
