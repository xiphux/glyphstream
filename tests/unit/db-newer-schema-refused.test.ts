/**
 * An older build started against a database a newer build migrated must
 * refuse to run rather than open it silently: drizzle skips migrations it
 * has already applied and ignores the ones it doesn't know.
 */
import { cpSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { drizzle } from 'drizzle-orm/node-sqlite';
import { migrate } from 'drizzle-orm/node-sqlite/migrator';
import { afterAll, describe, expect, it } from 'vitest';
import { assertNoNewerMigrations } from '#lib/server/db/client.js';

const MIGRATIONS = resolve('drizzle');
const work = mkdtempSync(join(tmpdir(), 'gs-newer-schema-'));
afterAll(() => rmSync(work, { recursive: true, force: true }));

const all = readdirSync(MIGRATIONS, { withFileTypes: true })
	.filter((d) => d.isDirectory())
	.map((d) => d.name)
	.sort();

/** A database the full chain migrated, as the newest build leaves it. */
function migratedDb(): DatabaseSync {
	const sqlite = new DatabaseSync(':memory:');
	migrate(drizzle({ client: sqlite }), { migrationsFolder: MIGRATIONS });
	return sqlite;
}

/** A migrations folder holding every migration but the last `drop`. */
function olderBuild(drop: number): string {
	const folder = join(work, `older-${drop}`);
	mkdirSync(folder);
	for (const name of all.slice(0, -drop)) {
		cpSync(join(MIGRATIONS, name), join(folder, name), { recursive: true });
	}
	return folder;
}

describe('assertNoNewerMigrations', () => {
	it('accepts a database at exactly this build', () => {
		expect(() => assertNoNewerMigrations(migratedDb(), MIGRATIONS)).not.toThrow();
	});

	it('refuses one migrated past this build, naming what it lacks', () => {
		const sqlite = migratedDb();
		const folder = olderBuild(2);
		// What getDb() does: migrate (a no-op here), then check.
		migrate(drizzle({ client: sqlite }), { migrationsFolder: folder });
		expect(() => assertNoNewerMigrations(sqlite, folder)).toThrow(
			new RegExp(`newer version.*${all.at(-2)}, ${all.at(-1)}.*not supported`, 's'),
		);
	});

	it('ignores rows recorded without a name', () => {
		const sqlite = migratedDb();
		sqlite.exec("INSERT INTO __drizzle_migrations (hash, created_at, name) VALUES ('x', 0, NULL)");
		expect(() => assertNoNewerMigrations(sqlite, MIGRATIONS)).not.toThrow();
	});
});
