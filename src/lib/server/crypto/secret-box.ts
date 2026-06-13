/**
 * Authenticated symmetric encryption for secrets stored at rest — currently
 * per-user MCP credentials (see db/queries/mcp-credentials.ts).
 *
 * AES-256-GCM. The 32-byte key is HKDF-SHA256-derived from `mcpSecretKey()`
 * (MCP_SECRET_KEY, or AUTH_SECRET as the fallback — so the operator can supply
 * any-length high-entropy string and we always feed AES a uniform key). The
 * HKDF `info` label domain-separates this key from any other use of the same
 * input (e.g. AUTH_SECRET's cookie signing), so sharing the input is safe.
 * Each ciphertext is `iv ‖ authTag ‖ ct`:
 *   - iv: 12 random bytes (GCM's standard nonce size)
 *   - authTag: 16 bytes (tamper detection — decrypt throws if the blob or
 *     key is wrong)
 *   - ct: the encrypted bytes
 *
 * A DB read alone can't recover a plaintext token: the attacker also needs
 * MCP_SECRET_KEY. Rotating that key invalidates all stored ciphertexts (they
 * fail the auth check on decrypt), which the callers surface as "re-enter
 * your token".
 */
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';
import { mcpSecretKey } from '../env';

const IV_LEN = 12;
const TAG_LEN = 16;
const KEY_LEN = 32;
// Domain-separation label for the HKDF expand step — distinguishes this use
// of MCP_SECRET_KEY from any future key derived from the same secret.
const HKDF_INFO = 'glyphstream-mcp-credential-v1';

let cachedKey: Buffer | null = null;

function key(): Buffer {
	if (cachedKey) return cachedKey;
	// mcpSecretKey() returns MCP_SECRET_KEY or falls back to AUTH_SECRET (always
	// set), so this never throws in a booted app.
	const secret = mcpSecretKey();
	const derived = hkdfSync(
		'sha256',
		Buffer.from(secret, 'utf8'),
		Buffer.alloc(0),
		HKDF_INFO,
		KEY_LEN,
	);
	cachedKey = Buffer.from(derived);
	return cachedKey;
}

/** Encrypt a UTF-8 secret. Returns `iv ‖ tag ‖ ciphertext` for blob storage. */
export function encryptSecret(plaintext: string): Buffer {
	const iv = randomBytes(IV_LEN);
	const cipher = createCipheriv('aes-256-gcm', key(), iv);
	const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
	const tag = cipher.getAuthTag();
	return Buffer.concat([iv, tag, ct]);
}

/**
 * Decrypt a blob produced by `encryptSecret`. Throws if the blob is
 * malformed, truncated, or fails GCM authentication (wrong key / tampered).
 */
export function decryptSecret(blob: Uint8Array): string {
	const buf = Buffer.from(blob);
	if (buf.length < IV_LEN + TAG_LEN + 1) {
		throw new Error('secret-box: ciphertext too short');
	}
	const iv = buf.subarray(0, IV_LEN);
	const tag = buf.subarray(IV_LEN, IV_LEN + TAG_LEN);
	const ct = buf.subarray(IV_LEN + TAG_LEN);
	const decipher = createDecipheriv('aes-256-gcm', key(), iv);
	decipher.setAuthTag(tag);
	return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
}

/** Test seam: drop the cached derived key (after changing the env in a test). */
export function _resetSecretKeyCacheForTests(): void {
	cachedKey = null;
}
