/**
 * Migrations against a database that has DATA in it, and the migrated schema
 * against schema.ts.
 *
 * Every other DB-backed test runs the full chain on an empty in-memory DB, and
 * CI's "Migrations match schema" step only compares schema.ts to drizzle-kit's
 * snapshots. Neither sees the failures that only exist on a real install:
 *
 *   - A step that can't apply to rows already there: ADD COLUMN NOT NULL with no
 *     default, a table rebuild whose INSERT … SELECT misses a column, a
 *     hand-written backfill that chokes on real values.
 *   - A step that applies but LOSES rows (a rebuild that filters, a cascade
 *     fired by a DROP) or leaves foreign keys dangling.
 *   - Hand-authored SQL (FTS tables, triggers, backfills — no snapshot) drifting
 *     from schema.ts, so the app's queries run against columns that aren't there.
 *
 * drizzle-orm (the migrator) and drizzle-kit (the SQL it emits) are both RCs
 * we upgrade by hand, which is exactly when this should be loud.
 *
 * The populated run applies the chain one migration at a time, filling every
 * table with synthetic rows (FK-consistent, typed by declared affinity) before
 * each next step.
 */
import { cpSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { drizzle } from 'drizzle-orm/node-sqlite';
import { migrate } from 'drizzle-orm/node-sqlite/migrator';
import { getTableConfig, type SQLiteTable } from 'drizzle-orm/sqlite-core';
import { is, Table } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import * as schema from '$lib/server/db/schema';

const MIGRATIONS = resolve('./drizzle');
const ROWS_PER_TABLE = 3;

interface ColumnInfo {
	name: string;
	type: string;
	notnull: number;
	dflt_value: string | null;
	pk: number;
}
interface ForeignKeyInfo {
	table: string;
	from: string;
	to: string | null;
}

const q = (id: string) => `"${id.replace(/"/g, '""')}"`;

function open(): DatabaseSync {
	const sqlite = new DatabaseSync(':memory:');
	sqlite.exec('PRAGMA foreign_keys = ON');
	return sqlite;
}

/** Ordinary tables the app owns — not SQLite's, not drizzle's, not FTS internals. */
function appTables(sqlite: DatabaseSync): string[] {
	const rows = sqlite
		.prepare(`SELECT name, sql FROM sqlite_master WHERE type = 'table' ORDER BY name`)
		.all() as Array<{ name: string; sql: string | null }>;
	const virtual = rows.filter((r) => /^CREATE VIRTUAL TABLE/i.test(r.sql ?? '')).map((r) => r.name);
	return rows
		.map((r) => r.name)
		.filter(
			(n) =>
				!n.startsWith('sqlite_') &&
				!n.startsWith('__drizzle') &&
				!virtual.includes(n) &&
				!virtual.some((v) => n.startsWith(`${v}_`)),
		);
}

const columns = (sqlite: DatabaseSync, table: string) =>
	sqlite.prepare(`PRAGMA table_info(${q(table)})`).all() as unknown as ColumnInfo[];
const foreignKeys = (sqlite: DatabaseSync, table: string) =>
	sqlite.prepare(`PRAGMA foreign_key_list(${q(table)})`).all() as unknown as ForeignKeyInfo[];
const count = (sqlite: DatabaseSync, table: string) =>
	(sqlite.prepare(`SELECT count(*) AS n FROM ${q(table)}`).get() as { n: number }).n;

/** Parents before children, so every FK can point at a real row. Only NOT NULL
 *  references constrain the order — a nullable one (conversations ↔ messages is
 *  a cycle) is left null when its parent isn't filled yet. */
function fkOrder(sqlite: DatabaseSync, tables: string[]): string[] {
	const done: string[] = [];
	const visit = (t: string, stack: string[]) => {
		if (done.includes(t) || stack.includes(t)) return;
		const required = new Set(
			columns(sqlite, t)
				.filter((c) => c.notnull)
				.map((c) => c.name),
		);
		for (const fk of foreignKeys(sqlite, t)) {
			if (fk.table !== t && tables.includes(fk.table) && required.has(fk.from)) {
				visit(fk.table, [...stack, t]);
			}
		}
		done.push(t);
	};
	for (const t of tables) visit(t, []);
	return done;
}

let seq = 0;

function fill(sqlite: DatabaseSync): void {
	const tables = appTables(sqlite);
	for (const table of fkOrder(sqlite, tables)) {
		const cols = columns(sqlite, table);
		const fks = foreignKeys(sqlite, table);
		let collisions = 0;
		while (count(sqlite, table) < ROWS_PER_TABLE) {
			seq++;
			const values = cols.map((c): string | number | Uint8Array | null => {
				const fk = fks.find((f) => f.from === c.name);
				if (fk) {
					const to = fk.to ?? 'rowid';
					// Deterministic: the sequence number picks the parent row.
					const parent = sqlite
						.prepare(`SELECT ${q(to)} AS v FROM ${q(fk.table)} ORDER BY rowid LIMIT 1 OFFSET ?`)
						.get(seq % Math.max(1, count(sqlite, fk.table))) as { v: string | number } | undefined;
					if (parent) return parent.v;
					if (!c.notnull) return null;
				}
				const type = c.type.toUpperCase();
				if (type.includes('INT')) return seq;
				if (type.includes('REAL') || type.includes('FLOA') || type.includes('DOUB'))
					return seq + 0.5;
				if (type.includes('BLOB')) return new Uint8Array([seq % 256]);
				// Text: JSON-shaped where the name says so, so backfills that parse it
				// see what the app writes.
				if (/json/i.test(c.name)) return '[]';
				return `${table}.${c.name}.${seq}`;
			});
			const sql = `INSERT INTO ${q(table)} (${cols.map((c) => q(c.name)).join(', ')}) VALUES (${cols
				.map(() => '?')
				.join(', ')})`;
			try {
				sqlite.prepare(sql).run(...values);
			} catch (e) {
				// A join table's composite key can repeat a parent pair; the next
				// sequence number picks different parents. Anything else is real.
				if (/UNIQUE/.test((e as Error).message) && ++collisions < 20) continue;
				throw new Error(`filling ${table}: ${(e as Error).message}`, { cause: e });
			}
		}
	}
}

describe('the migration chain on a populated database', () => {
	const staging = mkdtempSync(join(tmpdir(), 'gs-migrate-'));
	afterAll(() => rmSync(staging, { recursive: true, force: true }));

	it('applies every step to existing rows without losing any or breaking a foreign key', () => {
		const dirs = readdirSync(MIGRATIONS, { withFileTypes: true })
			.filter((e) => e.isDirectory())
			.map((e) => e.name)
			.sort();
		expect(dirs.length).toBeGreaterThan(40);

		const folder = join(staging, 'drizzle');
		mkdirSync(folder);
		const sqlite = open();
		const db = drizzle({ client: sqlite });

		for (const [i, dir] of dirs.entries()) {
			if (i > 0) fill(sqlite);
			const before = new Map(appTables(sqlite).map((t) => [t, count(sqlite, t)]));

			cpSync(join(MIGRATIONS, dir), join(folder, dir), { recursive: true });
			try {
				migrate(db, { migrationsFolder: folder });
			} catch (e) {
				throw new Error(`${dir} failed on a populated DB: ${(e as Error).message}`, { cause: e });
			}

			const after = new Map(appTables(sqlite).map((t) => [t, count(sqlite, t)]));
			for (const [table, n] of before) {
				expect(after.has(table), `${dir} dropped table ${table}`).toBe(true);
				expect(after.get(table), `${dir} lost rows from ${table}`).toBeGreaterThanOrEqual(n);
			}
			expect(sqlite.prepare('PRAGMA foreign_key_check').all(), `${dir} left dangling FKs`).toEqual(
				[],
			);
		}

		// The last step ran against data too, and the result is a sound file.
		fill(sqlite);
		expect(sqlite.prepare('PRAGMA integrity_check').get()).toEqual({ integrity_check: 'ok' });
		sqlite.close();
	});
});

describe('the migrated schema matches schema.ts', () => {
	const sqlite = open();
	migrate(drizzle({ client: sqlite }), { migrationsFolder: MIGRATIONS });
	afterAll(() => sqlite.close());

	const tables = (Object.values(schema) as unknown[])
		.filter((t): t is SQLiteTable => is(t, Table))
		.map((t) => getTableConfig(t));

	it('has exactly the tables schema.ts declares', () => {
		expect(appTables(sqlite).sort()).toEqual(tables.map((t) => t.name).sort());
	});

	it.each(tables.map((t) => [t.name, t] as const))('%s: columns, nullability, keys', (_n, t) => {
		const live = columns(sqlite, t.name);
		const declaredPk = new Set([
			...t.columns.filter((c) => c.primary).map((c) => c.name),
			...t.primaryKeys.flatMap((pk) => pk.columns.map((c) => c.name)),
		]);
		expect(
			live
				.map((c) => ({ name: c.name, notNull: c.notnull === 1 || c.pk > 0, pk: c.pk > 0 }))
				.sort((a, b) => a.name.localeCompare(b.name)),
		).toEqual(
			t.columns
				.map((c) => ({
					name: c.name,
					notNull: c.notNull || declaredPk.has(c.name),
					pk: declaredPk.has(c.name),
				}))
				.sort((a, b) => a.name.localeCompare(b.name)),
		);

		const liveIndexes = (
			sqlite.prepare(`PRAGMA index_list(${q(t.name)})`).all() as Array<{
				name: string;
				unique: number;
			}>
		).map((i) => ({ name: i.name, unique: i.unique === 1 }));
		for (const idx of t.indexes) {
			expect(liveIndexes).toContainEqual({ name: idx.config.name, unique: !!idx.config.unique });
		}

		const liveFks = foreignKeys(sqlite, t.name).map((f) => `${f.from}->${f.table}`);
		for (const fk of t.foreignKeys) {
			const ref = fk.reference();
			for (const col of ref.columns) {
				expect(liveFks).toContain(`${col.name}->${getTableConfig(ref.foreignTable).name}`);
			}
		}
	});
});
