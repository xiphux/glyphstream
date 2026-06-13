/**
 * Encryption for secrets at rest (per-user MCP credentials). The properties
 * that matter: a round-trip recovers the plaintext, a wrong/rotated key or a
 * tampered blob fails the GCM auth check (rather than returning garbage), and
 * each encryption uses a fresh IV.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ secretKey: 'master-key-one' }));
vi.mock('$lib/server/env', () => ({
	mcpSecretKey: () => mocks.secretKey,
}));

import {
	encryptSecret,
	decryptSecret,
	_resetSecretKeyCacheForTests,
} from '$lib/server/crypto/secret-box';

beforeEach(() => {
	mocks.secretKey = 'master-key-one';
	_resetSecretKeyCacheForTests();
});

describe('secret-box', () => {
	it('round-trips a secret', () => {
		const ct = encryptSecret('super-secret-token');
		expect(decryptSecret(ct)).toBe('super-secret-token');
	});

	it('round-trips unicode + empty-ish content', () => {
		const ct = encryptSecret('tøken—✓');
		expect(decryptSecret(ct)).toBe('tøken—✓');
	});

	it('uses a fresh IV so the same plaintext encrypts differently each time', () => {
		const a = encryptSecret('x');
		const b = encryptSecret('x');
		expect(Buffer.compare(a, b)).not.toBe(0);
	});

	it('fails to decrypt under a rotated key', () => {
		const ct = encryptSecret('tok');
		mocks.secretKey = 'a-different-master-key';
		_resetSecretKeyCacheForTests();
		expect(() => decryptSecret(ct)).toThrow();
	});

	it('rejects a tampered ciphertext (GCM auth)', () => {
		const ct = encryptSecret('tok');
		ct[ct.length - 1] ^= 0xff;
		expect(() => decryptSecret(ct)).toThrow();
	});

	it('rejects a too-short blob', () => {
		expect(() => decryptSecret(new Uint8Array([1, 2, 3]))).toThrow(/too short/);
	});
});
