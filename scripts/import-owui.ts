/**
 * CLI driver for importing an Open WebUI export into GlyphStream.
 *
 * Usage:
 *   node --experimental-strip-types scripts/import-owui.ts <export.json> --user-id <uuid>
 *
 * In the production Docker image, the script ships pre-compiled to JS:
 *   docker compose exec glyphstream node /app/scripts/import-owui.js \
 *     /imports/owui-export.json --user-id <uuid>
 *
 * The user id must already exist in the users table (i.e. the user has
 * logged in at least once via GitHub OAuth). Set DB_PATH in the
 * environment to point at the SQLite file (defaults to
 * `./data/glyphstream.db` to match the SvelteKit runtime default).
 *
 * The CLI sets up its own better-sqlite3 connection rather than going
 * through `src/lib/server/db/client` because that module pulls in
 * SvelteKit's `$env/dynamic/private`, which doesn't resolve outside the
 * SvelteKit runtime — same reason `drizzle.config.ts` reads process.env
 * directly.
 */

import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { eq } from 'drizzle-orm';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { argv, env, exit } from 'node:process';
import * as schema from '../src/lib/server/db/schema.ts';
import { importOwuiExport } from '../src/lib/server/import/owui.ts';

interface CliArgs {
	file: string;
	userId: string;
	dryRun: boolean;
}

function parseArgs(args: readonly string[]): CliArgs | string {
	let file: string | null = null;
	let userId: string | null = null;
	let dryRun = false;
	for (let i = 0; i < args.length; i++) {
		const a = args[i];
		if (a === '--user-id' || a === '-u') {
			userId = args[++i] ?? null;
		} else if (a === '--dry-run') {
			dryRun = true;
		} else if (a === '--help' || a === '-h') {
			return 'help';
		} else if (!a.startsWith('-')) {
			file = a;
		} else {
			return `Unknown option: ${a}`;
		}
	}
	if (!file) return 'Missing positional argument: <export.json>';
	if (!userId) return 'Missing required argument: --user-id <uuid>';
	return { file, userId, dryRun };
}

function printHelp(): void {
	console.log(
		[
			'Usage: import-owui <export.json> --user-id <uuid> [--dry-run]',
			'',
			'Reads an Open WebUI export file and imports its conversations',
			'into GlyphStream under the given user id.',
			'',
			'Options:',
			'  --user-id, -u <uuid>   GlyphStream user id (must already exist)',
			'  --dry-run              Parse + count, do not write to the DB',
			'  --help, -h             Show this help'
		].join('\n')
	);
}

const parsed = parseArgs(argv.slice(2));
if (parsed === 'help') {
	printHelp();
	exit(0);
}
if (typeof parsed === 'string') {
	console.error(parsed);
	console.error('Run with --help for usage.');
	exit(1);
}

const dbPath = resolve(env.DB_PATH ?? './data/glyphstream.db');
mkdirSync(dirname(dbPath), { recursive: true });
const sqlite = new Database(dbPath);
sqlite.pragma('journal_mode = WAL');
sqlite.pragma('synchronous = NORMAL');
sqlite.pragma('busy_timeout = 5000');
sqlite.pragma('foreign_keys = ON');
const db = drizzle(sqlite, { schema });
if (existsSync(resolve('./drizzle'))) {
	migrate(db, { migrationsFolder: resolve('./drizzle') });
}

// Confirm the target user actually exists before doing any import work,
// so we fail fast rather than write rows owned by a phantom uuid.
const userExists = db
	.select({ id: schema.users.id })
	.from(schema.users)
	.where(eq(schema.users.id, parsed.userId))
	.get();
if (!userExists) {
	console.error(`User id "${parsed.userId}" not found in the users table.`);
	console.error('The user must have logged in via GitHub OAuth at least once.');
	sqlite.close();
	exit(1);
}

const raw = readFileSync(parsed.file, 'utf8');
let json: unknown;
try {
	json = JSON.parse(raw);
} catch (e) {
	console.error(`Failed to parse JSON: ${e instanceof Error ? e.message : String(e)}`);
	sqlite.close();
	exit(1);
}

console.log(`Importing ${parsed.file}${parsed.dryRun ? ' (dry run)' : ''}…`);
const result = importOwuiExport(json, parsed.userId, db, { dryRun: parsed.dryRun });

console.log('');
console.log(`Imported:  ${result.imported}`);
console.log(`  …archived: ${result.archived}`);
console.log(`Skipped:   ${result.skipped.length}`);
for (const s of result.skipped) {
	console.log(`  - ${s.id}: ${s.reason}`);
}
console.log(`Errors:    ${result.errors.length}`);
for (const e of result.errors) {
	console.error(`  ! ${e.id}: ${e.reason}`);
}

sqlite.close();
if (result.errors.length > 0) exit(2);
