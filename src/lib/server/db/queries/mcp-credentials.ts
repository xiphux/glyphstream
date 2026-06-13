/**
 * Per-user MCP credential queries. The stored secret is encrypted at rest
 * (AES-256-GCM via crypto/secret-box) — `getMcpCredential` is the only place
 * it's decrypted, and only server-side at connect time. `serverId` is the
 * config-defined id; there's no FK to a servers table because config.toml,
 * not the DB, owns the list of MCP servers.
 */
import { and, eq } from 'drizzle-orm';
import { generateId } from '../../util/id';
import { getDb } from '../client';
import { mcpCredentials } from '../schema';
import { decryptSecret, encryptSecret } from '../../crypto/secret-box';

/** The decrypted secret for (user, server), or null when none is stored. */
export function getMcpCredential(userId: string, serverId: string): string | null {
	const db = getDb();
	const row = db
		.select({ ct: mcpCredentials.secretCiphertext })
		.from(mcpCredentials)
		.where(and(eq(mcpCredentials.userId, userId), eq(mcpCredentials.serverId, serverId)))
		.get();
	if (!row) return null;
	try {
		return decryptSecret(row.ct as Uint8Array);
	} catch {
		// Key rotated, or the row predates a key change / is corrupt. Treat as
		// "no usable credential" so the user is prompted to re-enter rather than
		// the MCP connection hard-failing with a crypto error.
		return null;
	}
}

/** Upsert (insert or replace) the encrypted secret for (user, server). */
export function setMcpCredential(userId: string, serverId: string, secret: string): void {
	const db = getDb();
	const ct = encryptSecret(secret);
	const now = Date.now();
	const existing = db
		.select({ id: mcpCredentials.id })
		.from(mcpCredentials)
		.where(and(eq(mcpCredentials.userId, userId), eq(mcpCredentials.serverId, serverId)))
		.get();
	if (existing) {
		db.update(mcpCredentials)
			.set({ secretCiphertext: ct, updatedAt: now })
			.where(eq(mcpCredentials.id, existing.id))
			.run();
	} else {
		db.insert(mcpCredentials)
			.values({
				id: generateId(),
				userId,
				serverId,
				secretCiphertext: ct,
				createdAt: now,
				updatedAt: now,
			})
			.run();
	}
}

/** Remove a user's credential for a server. Returns false if none existed. */
export function deleteMcpCredential(userId: string, serverId: string): boolean {
	const db = getDb();
	const res = db
		.delete(mcpCredentials)
		.where(and(eq(mcpCredentials.userId, userId), eq(mcpCredentials.serverId, serverId)))
		.run();
	return res.changes > 0;
}

/** Whether the user has a stored credential for the server (no decrypt). */
export function hasMcpCredential(userId: string, serverId: string): boolean {
	const db = getDb();
	const row = db
		.select({ id: mcpCredentials.id })
		.from(mcpCredentials)
		.where(and(eq(mcpCredentials.userId, userId), eq(mcpCredentials.serverId, serverId)))
		.get();
	return row !== undefined;
}

/** All server ids this user has a credential for — drives per-user tool
 *  availability and the settings page's "configured" state. */
export function listConfiguredServerIds(userId: string): string[] {
	const db = getDb();
	return db
		.select({ serverId: mcpCredentials.serverId })
		.from(mcpCredentials)
		.where(eq(mcpCredentials.userId, userId))
		.all()
		.map((r) => r.serverId);
}
