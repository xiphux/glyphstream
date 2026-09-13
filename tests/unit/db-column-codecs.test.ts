/**
 * Every column whose value drizzle converts on the way in or out — blobs and
 * booleans — round-trips through the app's own query functions, AND lands in
 * SQLite as the storage class existing databases already hold.
 *
 * This is where a drizzle-orm RC has already bitten: rc.4 made a bare `blob()`
 * default to JSON mode, which would have written embeddings and passkey keys as
 * JSON text and read them back as garbage. `mode: 'buffer'` is the fix, and
 * nothing asserted it. The storage check matters as much as the round trip — a
 * codec change that is symmetric still passes a write-then-read test while every
 * row written before the upgrade becomes unreadable.
 *
 * The first test enumerates converted columns from schema.ts, so a new blob or
 * boolean column fails here until it has a case.
 */
import { is, sql, Table } from 'drizzle-orm';
import { getTableConfig } from 'drizzle-orm/sqlite-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDb, closeTestDb, type TestDB } from './_helpers/test-db';
import { seedUser } from './_helpers/seed';

const mocks = vi.hoisted(() => ({ testDb: null as unknown as TestDB }));
vi.mock('$lib/server/db/client', () => ({ getDb: () => mocks.testDb, closeDb: () => {} }));
vi.mock('$lib/server/env', async (importOriginal) => ({
	...(await importOriginal<typeof import('$lib/server/env')>()),
	mcpSecretKey: () => 'codec-test-key-not-a-secret',
}));

import * as schema from '$lib/server/db/schema';
import { createConversation, getConversationMeta } from '$lib/server/db/queries/conversations';
import {
	createMemory,
	listMemoryRecallVectors,
	setMemoryEmbedding,
} from '$lib/server/db/queries/memories';
import {
	insertMedia,
	listMediaEmbeddingsForUser,
	setMediaEmbedding,
} from '$lib/server/db/queries/media';
import { getMcpCredential, setMcpCredential } from '$lib/server/db/queries/mcp-credentials';
import { findCredentialById, insertCredential } from '$lib/server/db/queries/passkey';
import { decodeVector, encodeVector } from '$lib/server/retrieval/vector';

const COVERED = [
	'conversations.private',
	'mcp_credentials.secret_ciphertext',
	'media.embedding',
	'memories.embedding',
	'passkey_credentials.backed_up',
	'passkey_credentials.public_key',
];

/** `typeof(col)` and the raw value, bypassing drizzle's decoder. */
function raw(table: string, column: string, where: string) {
	return mocks.testDb.get<{ t: string; v: unknown }>(
		sql.raw(`SELECT typeof("${column}") AS t, "${column}" AS v FROM "${table}" WHERE ${where}`),
	);
}

let userId: string;

beforeEach(() => {
	mocks.testDb = createTestDb();
	userId = seedUser().id;
});

afterEach(() => {
	closeTestDb();
});

it('has a case for every converted (blob / boolean) column in schema.ts', () => {
	const converted: string[] = [];
	for (const t of Object.values(schema) as unknown[]) {
		if (!is(t, Table)) continue;
		const cfg = getTableConfig(t as Parameters<typeof getTableConfig>[0]);
		for (const c of cfg.columns) {
			if (!['SQLiteText', 'SQLiteInteger', 'SQLiteReal'].includes(c.columnType)) {
				converted.push(`${cfg.name}.${c.name}`);
			}
		}
	}
	expect(converted.sort()).toEqual(COVERED);
});

describe('embedding blobs', () => {
	const vector = [0.25, -1.5, 3.125, 1e-7, -0];

	it('memories.embedding: Float32 bytes in a BLOB, decoded back to the same vector', () => {
		const { id } = createMemory(userId, 'likes tea');
		expect(setMemoryEmbedding(id, 'likes tea', encodeVector(vector), 'embed-v1')).toBe(true);

		expect(raw('memories', 'embedding', `id = '${id}'`)).toMatchObject({ t: 'blob' });
		expect((raw('memories', 'embedding', `id = '${id}'`)!.v as Uint8Array).byteLength).toBe(20);

		const [row] = listMemoryRecallVectors(userId, 'embed-v1');
		expect(Array.from(decodeVector(row.embedding))).toEqual(Array.from(Float32Array.from(vector)));
	});

	it('media.embedding: Float32 bytes in a BLOB, decoded back to the same vector', () => {
		const { id } = insertMedia({
			userId,
			storagePath: 'ab/cd/x.png',
			contentType: 'image/png',
			byteSize: 1,
			kind: 'image',
			sourceEndpointId: 'e',
			sourceModel: 'm',
			promptExcerpt: 'a cat',
			promptFull: 'a cat',
		});
		expect(setMediaEmbedding(id, 'a cat', encodeVector(vector), 'embed-v1')).toBe(true);

		expect(raw('media', 'embedding', `id = '${id}'`)).toMatchObject({ t: 'blob' });
		const [row] = listMediaEmbeddingsForUser(userId, { embeddingModel: 'embed-v1' });
		expect(Array.from(decodeVector(row.embedding))).toEqual(Array.from(Float32Array.from(vector)));
	});
});

describe('passkey_credentials', () => {
	// A COSE key is binary with bytes that aren't valid UTF-8 — the case a text
	// or JSON codec corrupts.
	const publicKey = new Uint8Array([
		0xa5, 0x01, 0x02, 0x03, 0x26, 0x20, 0x01, 0x21, 0xff, 0x00, 0xfe,
	]);

	it.each([true, false])('public_key bytes and backed_up=%s survive exactly', (backedUp) => {
		insertCredential({
			id: `cred-${backedUp}`,
			userId,
			publicKey,
			counter: 7,
			transports: ['internal'],
			backedUp,
			deviceType: backedUp ? 'multiDevice' : 'singleDevice',
			name: null,
		});

		expect(raw('passkey_credentials', 'public_key', `id = 'cred-${backedUp}'`)).toMatchObject({
			t: 'blob',
		});
		expect(raw('passkey_credentials', 'backed_up', `id = 'cred-${backedUp}'`)).toEqual({
			t: 'integer',
			v: backedUp ? 1 : 0,
		});

		const row = findCredentialById(`cred-${backedUp}`)!;
		expect(new Uint8Array(row.publicKey)).toEqual(publicKey);
		expect(row.backedUp).toBe(backedUp);
	});
});

describe('mcp_credentials.secret_ciphertext', () => {
	it('stores the sealed secret as a BLOB and opens it again', () => {
		setMcpCredential(userId, 'server-1', 'tok_sensitive_✓');
		const stored = raw('mcp_credentials', 'secret_ciphertext', `user_id = '${userId}'`)!;
		expect(stored.t).toBe('blob');
		expect(Buffer.from(stored.v as Uint8Array).includes('tok_sensitive')).toBe(false);
		expect(getMcpCredential(userId, 'server-1')).toBe('tok_sensitive_✓');
	});
});

describe('conversations.private', () => {
	it.each([true, false])('private=%s is stored as 0/1 and read back as a boolean', (isPrivate) => {
		const { id } = createConversation({
			userId,
			endpointId: 'e',
			modelId: 'm',
			modelKind: null,
			private: isPrivate,
		});
		expect(raw('conversations', 'private', `id = '${id}'`)).toEqual({
			t: 'integer',
			v: isPrivate ? 1 : 0,
		});
		expect(getConversationMeta(id, userId)!.private).toBe(isPrivate);
	});
});
