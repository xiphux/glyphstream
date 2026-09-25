/**
 * Put the code interpreter's worker next to whichever server chunk spawns it.
 *
 *   node scripts/place-worker.mjs   (the last step of `pnpm build`)
 *
 * pool.ts starts the worker with `new URL('./worker.js', import.meta.url)`, so
 * the file has to sit beside the BUILT chunk that line ends up in. Vite keeps
 * the URL but doesn't emit a .js file it references (it reads as "import this
 * code", not "this is an asset"), so the build copies it in afterwards.
 *
 * It used to copy to a fixed `build/server/chunks/`, which is where that chunk
 * sat until adapter-node 5.5.6 started preserving Vite's own `chunks/` folder
 * inside its chunk names (sveltejs/kit#16092). The pool code moved to
 * `build/server/chunks/chunks/`, the copy didn't, and every `run_python` call
 * in a production build failed to start its worker — silently, since nothing
 * but a live call ever spawns one. So this finds the chunk by what it
 * contains rather than where it is expected to be, and FAILS the build when it
 * finds none: a refactor that renames the file or changes how the URL is
 * written should break here, not in production.
 *
 * Plain .mjs importing nothing outside node: builtins, like changelog.mjs.
 */

import { copyFileSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import process from 'node:process';

const WORKER_SRC = 'src/lib/server/code-interpreter/worker.js';
const SERVER_DIR = 'build/server';
// How Vite prints the line from pool.ts. Quote style is Vite's, not ours.
const SPAWN_URL = /new URL\(\s*["']\.\/worker\.js["']\s*,\s*import\.meta\.url\s*\)/;

const chunks = readdirSync(SERVER_DIR, { recursive: true })
	.filter((f) => f.endsWith('.js'))
	.map((f) => join(SERVER_DIR, f))
	.filter((f) => SPAWN_URL.test(readFileSync(f, 'utf8')));

if (chunks.length === 0) {
	console.error(
		`place-worker: no chunk under ${SERVER_DIR} contains new URL('./worker.js', import.meta.url).\n` +
			'The code interpreter could not start its worker from this build. If pool.ts changed ' +
			'how it resolves the worker, update this script to match.',
	);
	process.exit(1);
}

// Normally exactly one, but more is harmless: each gets its own copy.
for (const dir of new Set(chunks.map((f) => dirname(f)))) {
	copyFileSync(WORKER_SRC, join(dir, 'worker.js'));
	console.log(`place-worker: ${WORKER_SRC} -> ${relative('.', join(dir, 'worker.js'))}`);
}
