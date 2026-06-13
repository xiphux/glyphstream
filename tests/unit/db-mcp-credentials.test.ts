/**
 * Per-user MCP credential storage. Verifies the ciphertext (not the secret)
 * is what's persisted, the (user, server) scoping holds, upsert replaces, and
 * a key rotation degrades to "no usable credential" rather than throwing.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDb, closeTestDb, type TestDB } from './_helpers/test-db';
import { seedUser } from './_helpers/seed';

const mocks = vi.hoisted(() => ({
	testDb: null as unknown as TestDB,
	secretKey: 'mcp-master-key-one',
}));
vi.mock('$lib/server/db/client', () => ({
	getDb: () => mocks.testDb,
	closeDb: () => {},
}));
vi.mock('$lib/server/env', () => ({
	mcpSecretKey: () => mocks.secretKey,
}));

import {
	getMcpCredential,
	setMcpCredential,
	deleteMcpCredential,
	hasMcpCredential,
	listConfiguredServerIds,
} from '$lib/server/db/queries/mcp-credentials';
import { _resetSecretKeyCacheForTests } from '$lib/server/crypto/secret-box';
import { mcpCredentials } from '../../src/lib/server/db/schema';

beforeEach(() => {
	mocks.testDb = createTestDb();
	mocks.secretKey = 'mcp-master-key-one';
	_resetSecretKeyCacheForTests();
});
afterEach(() => closeTestDb());

describe('mcp-credentials', () => {
	it('stores ciphertext (not the plaintext token) and decrypts on read', () => {
		const u = seedUser();
		setMcpCredential(u.id, 'fastmail', 'token-abc123');
		// Raw stored bytes must not contain the plaintext.
		const raw = mocks.testDb.select().from(mcpCredentials).all();
		expect(raw).toHaveLength(1);
		const stored = Buffer.from(raw[0].secretCiphertext as Uint8Array).toString('utf8');
		expect(stored).not.toContain('token-abc123');
		// But the query decrypts it back.
		expect(getMcpCredential(u.id, 'fastmail')).toBe('token-abc123');
	});

	it('scopes by (user, server)', () => {
		const a = seedUser();
		const b = seedUser();
		setMcpCredential(a.id, 'fastmail', 'a-token');
		expect(getMcpCredential(b.id, 'fastmail')).toBeNull();
		expect(getMcpCredential(a.id, 'other-server')).toBeNull();
		expect(hasMcpCredential(a.id, 'fastmail')).toBe(true);
		expect(hasMcpCredential(b.id, 'fastmail')).toBe(false);
	});

	it('upserts (replaces) an existing credential without duplicating rows', () => {
		const u = seedUser();
		setMcpCredential(u.id, 'fastmail', 'first');
		setMcpCredential(u.id, 'fastmail', 'second');
		expect(getMcpCredential(u.id, 'fastmail')).toBe('second');
		expect(mocks.testDb.select().from(mcpCredentials).all()).toHaveLength(1);
	});

	it('lists configured server ids for a user', () => {
		const u = seedUser();
		setMcpCredential(u.id, 'fastmail', 't1');
		setMcpCredential(u.id, 'slack', 't2');
		expect(new Set(listConfiguredServerIds(u.id))).toEqual(new Set(['fastmail', 'slack']));
	});

	it('deletes a credential', () => {
		const u = seedUser();
		setMcpCredential(u.id, 'fastmail', 't');
		expect(deleteMcpCredential(u.id, 'fastmail')).toBe(true);
		expect(getMcpCredential(u.id, 'fastmail')).toBeNull();
		expect(deleteMcpCredential(u.id, 'fastmail')).toBe(false);
	});

	it('returns null (not throw) when the master key has rotated', () => {
		const u = seedUser();
		setMcpCredential(u.id, 'fastmail', 'token');
		mocks.secretKey = 'rotated-master-key';
		_resetSecretKeyCacheForTests();
		// Row still exists, but it can't be decrypted — surfaces as "no credential".
		expect(getMcpCredential(u.id, 'fastmail')).toBeNull();
		expect(hasMcpCredential(u.id, 'fastmail')).toBe(true);
	});
});
