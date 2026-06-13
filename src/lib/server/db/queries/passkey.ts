/**
 * Passkey credential queries. Every user is bootstrapped via GitHub
 * OAuth, so this table only ever holds *additional* sign-in methods —
 * the user_id always exists in `users` before any row here is written.
 *
 * Two visibility shapes:
 *  - PasskeyCredentialRow — the full row including public_key bytes and
 *    counter. Used by the WebAuthn verify path.
 *  - PasskeySummary — UI-safe subset (omits public_key + counter) so the
 *    SSR payload to the settings page never ships raw key material to
 *    the client.
 *
 * Mutations are user-scoped (rename / delete) so a tampered credential
 * id from another user's row simply matches zero. findCredentialById is
 * *not* user-scoped — usernameless login arrives with the credential id
 * before we know which user owns it.
 */

import { and, asc, eq } from 'drizzle-orm';
import { getDb, type Tx } from '../client';
import { passkeyCredentials, users } from '../schema';

export type AuthenticatorTransport = 'usb' | 'ble' | 'nfc' | 'internal' | 'hybrid';
export type PasskeyDeviceType = 'singleDevice' | 'multiDevice';

export interface PasskeyCredentialRow {
	id: string;
	userId: string;
	publicKey: Uint8Array;
	counter: number;
	transports: AuthenticatorTransport[] | null;
	backedUp: boolean;
	deviceType: PasskeyDeviceType;
	name: string | null;
	createdAt: number;
	lastUsedAt: number | null;
}

export interface PasskeySummary {
	id: string;
	name: string | null;
	backedUp: boolean;
	deviceType: PasskeyDeviceType;
	createdAt: number;
	lastUsedAt: number | null;
}

export interface InsertPasskeyInput {
	id: string;
	userId: string;
	publicKey: Uint8Array;
	counter: number;
	transports: AuthenticatorTransport[] | null;
	backedUp: boolean;
	deviceType: PasskeyDeviceType;
	name: string | null;
}

interface RawRow {
	id: string;
	userId: string;
	publicKey: Buffer | Uint8Array;
	counter: number;
	transportsJson: string | null;
	backedUp: boolean;
	deviceType: PasskeyDeviceType;
	name: string | null;
	createdAt: number;
	lastUsedAt: number | null;
}

const VALID_TRANSPORTS: ReadonlySet<AuthenticatorTransport> = new Set([
	'usb',
	'ble',
	'nfc',
	'internal',
	'hybrid',
]);

function parseTransports(raw: string | null): AuthenticatorTransport[] | null {
	if (!raw) return null;
	try {
		const parsed: unknown = JSON.parse(raw);
		if (!Array.isArray(parsed)) return null;
		const out: AuthenticatorTransport[] = [];
		for (const t of parsed) {
			if (typeof t === 'string' && VALID_TRANSPORTS.has(t as AuthenticatorTransport)) {
				out.push(t as AuthenticatorTransport);
			}
		}
		return out;
	} catch {
		// Malformed JSON in the DB shouldn't crash a login — drop to "no
		// hints" and let the browser show every option. The row was
		// inserted by our own code with JSON.stringify, so this is the
		// "manual edit / corruption" path.
		return null;
	}
}

function toRow(raw: RawRow): PasskeyCredentialRow {
	// Copy bytes into a freshly-allocated Uint8Array. `new Uint8Array(N)`
	// guarantees an `ArrayBuffer` (not `SharedArrayBuffer`), which is what
	// SimpleWebAuthn's strict `Uint8Array<ArrayBuffer>` parameter requires
	// — `Uint8Array.from(buf)` inherits Node's looser `ArrayBufferLike`
	// from `Buffer` and trips a tsc mismatch at the verify call site.
	const src = raw.publicKey;
	const publicKey = new Uint8Array(src.length);
	publicKey.set(src);
	return {
		id: raw.id,
		userId: raw.userId,
		publicKey,
		counter: raw.counter,
		transports: parseTransports(raw.transportsJson),
		backedUp: raw.backedUp,
		deviceType: raw.deviceType,
		name: raw.name,
		createdAt: raw.createdAt,
		lastUsedAt: raw.lastUsedAt,
	};
}

function toSummary(row: PasskeyCredentialRow): PasskeySummary {
	return {
		id: row.id,
		name: row.name,
		backedUp: row.backedUp,
		deviceType: row.deviceType,
		createdAt: row.createdAt,
		lastUsedAt: row.lastUsedAt,
	};
}

/** All credentials for a user, oldest-first. Used by the settings page
 *  and to build excludeCredentials during registration. */
export function listCredentialsForUser(userId: string): PasskeyCredentialRow[] {
	const db = getDb();
	const rows = db
		.select()
		.from(passkeyCredentials)
		.where(eq(passkeyCredentials.userId, userId))
		.orderBy(asc(passkeyCredentials.createdAt))
		.all() as RawRow[];
	return rows.map(toRow);
}

/** UI-safe projection — never includes public_key or counter. */
export function listCredentialSummariesForUser(userId: string): PasskeySummary[] {
	return listCredentialsForUser(userId).map(toSummary);
}

/** Resolve a credential by its (global) ID. NOT user-scoped —
 *  usernameless login has no user context until this returns. */
export function findCredentialById(credentialId: string): PasskeyCredentialRow | null {
	const db = getDb();
	const row = db
		.select()
		.from(passkeyCredentials)
		.where(eq(passkeyCredentials.id, credentialId))
		.get() as RawRow | undefined;
	return row ? toRow(row) : null;
}

export interface UserForCredential {
	userId: string;
	disabledAt: number | null;
}

/** Join helper: given a credential id, return the owning user's
 *  internal id + revocation flag (login-verify uses `disabledAt`
 *  instead of the dropped allowlist re-check). Null when the
 *  credential doesn't exist. */
export function findUserForCredential(credentialId: string): UserForCredential | null {
	const db = getDb();
	const row = db
		.select({
			userId: users.id,
			disabledAt: users.disabledAt,
		})
		.from(passkeyCredentials)
		.innerJoin(users, eq(passkeyCredentials.userId, users.id))
		.where(eq(passkeyCredentials.id, credentialId))
		.get();
	return row ?? null;
}

export function insertCredential(input: InsertPasskeyInput, tx?: Tx): void {
	const exec = tx ?? getDb();
	exec
		.insert(passkeyCredentials)
		.values({
			id: input.id,
			userId: input.userId,
			publicKey: Buffer.from(input.publicKey),
			counter: input.counter,
			transportsJson: input.transports ? JSON.stringify(input.transports) : null,
			backedUp: input.backedUp,
			deviceType: input.deviceType,
			name: input.name,
			createdAt: Date.now(),
			lastUsedAt: null,
		})
		.run();
}

/** Single UPDATE that bumps counter + last_used_at atomically. Called
 *  on every successful login-verify. */
export function updateCredentialCounterAndLastUsed(
	credentialId: string,
	counter: number,
	lastUsedAt: number,
): void {
	const db = getDb();
	db.update(passkeyCredentials)
		.set({ counter, lastUsedAt })
		.where(eq(passkeyCredentials.id, credentialId))
		.run();
}

/** User-scoped rename. Returns true iff a row matched. */
export function renameCredential(
	userId: string,
	credentialId: string,
	name: string | null,
): boolean {
	const db = getDb();
	const result = db
		.update(passkeyCredentials)
		.set({ name })
		.where(and(eq(passkeyCredentials.userId, userId), eq(passkeyCredentials.id, credentialId)))
		.run();
	return result.changes > 0;
}

/** User-scoped delete. Returns true iff a row matched. */
export function deleteCredential(userId: string, credentialId: string): boolean {
	const db = getDb();
	const result = db
		.delete(passkeyCredentials)
		.where(and(eq(passkeyCredentials.userId, userId), eq(passkeyCredentials.id, credentialId)))
		.run();
	return result.changes > 0;
}

/** Used by the last-method guard before a delete: refuse to remove the
 *  user's only passkey when GitHub login is also disabled. */
export function countCredentialsForUser(userId: string): number {
	const db = getDb();
	const rows = db
		.select({ id: passkeyCredentials.id })
		.from(passkeyCredentials)
		.where(eq(passkeyCredentials.userId, userId))
		.all();
	return rows.length;
}
