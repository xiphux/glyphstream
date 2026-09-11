/**
 * One-shot backfill: move the index to the front of videos stored before
 * GlyphStream started doing it at write time.
 *
 * Local dev:
 *   pnpm tsx scripts/faststart-backfill.ts --dry-run
 *   pnpm tsx scripts/faststart-backfill.ts
 *
 * Inside a running container:
 *   docker compose exec glyphstream node /app/build/scripts/faststart-backfill.js
 *
 * Reads DB_PATH and MEDIA_DIR from the environment, matching the SvelteKit
 * runtime defaults. Opens its own node:sqlite connection rather than going
 * through src/lib/server/db/client, which pulls in $env/dynamic/private and
 * doesn't resolve outside the SvelteKit runtime — same reason import-owui.ts
 * does.
 *
 * SAFE TO RUN REPEATEDLY, and that is the design rather than a nicety. The
 * alternative — rewrite the file, then update the row, and hope nothing dies in
 * between — has a window where the row describes a file that no longer exists
 * at that size. Instead every run re-derives the truth for every video: is the
 * index at the front, and does the row's byteSize match the file? Whatever is
 * wrong gets fixed. So an interrupted run is repaired by running it again,
 * there is no resume state to keep, and it can be run after the fact to verify.
 *
 * The stakes are lower than they look. media.byteSize has exactly one consumer
 * — the clamp input to parseRange in the content endpoint — while Content-Length
 * and Content-Range both come from a stat of the real file. A row that is a few
 * bytes stale produces a range clamped against a slightly wrong number that
 * open() then re-clamps correctly. Worth fixing, not worth a transaction.
 */

import { DatabaseSync } from 'node:sqlite';
import { drizzle } from 'drizzle-orm/node-sqlite';
import { eq, isNull, and } from 'drizzle-orm';
import { statSync } from 'node:fs';
import { resolve } from 'node:path';
import { argv, env, exit } from 'node:process';
import * as schema from '../src/lib/server/db/schema.ts';
import { isFaststart, makeFaststart } from '../src/lib/server/media/faststart.ts';

const dryRun = argv.includes('--dry-run');
if (argv.includes('--help') || argv.includes('-h')) {
	console.log('Usage: faststart-backfill.ts [--dry-run]');
	console.log('  Rewrites stored videos so their index precedes their samples,');
	console.log('  and reconciles media.byteSize with what is on disk.');
	console.log('  Safe to run repeatedly; re-running repairs an interrupted run.');
	exit(0);
}

const dbPath = resolve(env.DB_PATH ?? './data/glyphstream.db');
const mediaRoot = resolve(env.MEDIA_DIR ?? './data/media');

const sqlite = new DatabaseSync(dbPath);
sqlite.exec('PRAGMA journal_mode = WAL');
sqlite.exec('PRAGMA busy_timeout = 5000');
const db = drizzle({ client: sqlite, schema });

// Not hard-deleted: those rows keep their bytes only until the purger runs, and
// rewriting a file that is on its way out is pure waste.
const videos = db
	.select({
		id: schema.media.id,
		storagePath: schema.media.storagePath,
		byteSize: schema.media.byteSize,
	})
	.from(schema.media)
	.where(and(eq(schema.media.kind, 'video'), isNull(schema.media.hardDeletedAt)))
	.all();

console.log(`${videos.length} video row${videos.length === 1 ? '' : 's'} to inspect.`);
if (dryRun) console.log('Dry run — nothing will be written.\n');

let remuxed = 0;
let alreadyOk = 0;
let sizeFixed = 0;
let skipped = 0;
let missing = 0;

for (const video of videos) {
	const abs = resolve(mediaRoot, video.storagePath);

	let onDisk: number;
	try {
		onDisk = statSync(abs).size;
	} catch {
		// A row whose bytes are gone. Not this script's problem to resolve, and
		// definitely not something to guess at.
		missing++;
		continue;
	}

	const state = await isFaststart(abs);

	if (state === null) {
		// Not an mp4, or unreadable as one. WebM and friends land here and are
		// correctly left alone — the question doesn't apply to them.
		skipped++;
	} else if (state === false) {
		if (dryRun) {
			console.log(`would remux  ${video.storagePath}`);
			remuxed++;
		} else {
			const newSize = await makeFaststart(abs);
			if (newSize === null) {
				console.warn(`could not remux, left as-is: ${video.storagePath}`);
				skipped++;
			} else {
				db.update(schema.media)
					.set({ byteSize: newSize })
					.where(eq(schema.media.id, video.id))
					.run();
				remuxed++;
			}
		}
		continue;
	} else {
		alreadyOk++;
	}

	// Reconcile the row even when the file needed no rewrite. This is what makes
	// a re-run repair a previous run that died between the rename and the update.
	const current = dryRun ? onDisk : statSync(abs).size;
	if (current !== video.byteSize) {
		if (dryRun) {
			console.log(`would fix size ${video.storagePath}: ${video.byteSize} -> ${current}`);
		} else {
			db.update(schema.media).set({ byteSize: current }).where(eq(schema.media.id, video.id)).run();
		}
		sizeFixed++;
	}
}

console.log('');
console.log(`  remuxed:        ${remuxed}`);
console.log(`  already ok:     ${alreadyOk}`);
console.log(`  size corrected: ${sizeFixed}`);
console.log(`  skipped:        ${skipped}`);
if (missing > 0) console.log(`  bytes missing:  ${missing}`);
if (dryRun) console.log('\nDry run — nothing was written.');

sqlite.close();
