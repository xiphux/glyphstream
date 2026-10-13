/**
 * Every foreign key that references messages.id must be indexed.
 *
 * SQLite enforces a parent-side delete by looking the deleted key up in each
 * child column; without an index that is a full scan of the child table, paid
 * once per deleted message. Messages are deleted in bulk (conversation delete,
 * branch delete on every fan-out discard), so an un-indexed child turns a
 * 1,500-message delete into seconds of synchronous work at 20k conversations.
 */
import { DatabaseSync } from 'node:sqlite';
import { resolve } from 'node:path';
import { drizzle } from 'drizzle-orm/node-sqlite';
import { migrate } from 'drizzle-orm/node-sqlite/migrator';
import { describe, expect, it } from 'vitest';

describe('foreign keys referencing messages', () => {
	it('each has an index leading with the referencing column', () => {
		const sqlite = new DatabaseSync(':memory:');
		migrate(drizzle({ client: sqlite }), { migrationsFolder: resolve('./drizzle') });

		const tables = sqlite
			.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
			.all() as Array<{ name: string }>;
		const missing: string[] = [];
		for (const { name } of tables) {
			const fks = sqlite.prepare(`PRAGMA foreign_key_list("${name}")`).all() as Array<{
				table: string;
				from: string;
			}>;
			const leading = new Set(
				(sqlite.prepare(`PRAGMA index_list("${name}")`).all() as Array<{ name: string }>).map(
					(idx) =>
						(sqlite.prepare(`PRAGMA index_info("${idx.name}")`).all() as Array<{ name: string }>)[0]
							?.name,
				),
			);
			for (const fk of fks) {
				if (fk.table === 'messages' && !leading.has(fk.from)) missing.push(`${name}.${fk.from}`);
			}
		}
		sqlite.close();
		expect(missing).toEqual([]);
	});
});
