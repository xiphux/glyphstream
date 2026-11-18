/**
 * Put each esbuild-bundled worker next to whichever server chunk starts it.
 *
 *   node scripts/place-worker.mjs   (the last step of `pnpm build`)
 *
 * The code interpreter's pool.ts starts its worker with
 * `new URL('./worker.js', import.meta.url)`, and fetch_url's
 * extract-in-worker.ts starts its with
 * `new URL('./fetch-extract-worker.js', import.meta.url)`, so each file has to
 * sit beside the BUILT chunk that line ends up in. Vite keeps the URL but
 * doesn't emit a .js file it references (it reads as "import this code", not
 * "this is an asset"), so the build copies it in afterwards.
 *
 * A fixed destination breaks without warning: adapter-node 5.5.6 started
 * preserving Vite's own `chunks/` folder inside its chunk names
 * (sveltejs/kit#16092), which moved the pool code from `build/server/chunks/`
 * to `build/server/chunks/chunks/`. A copy to the old path left every
 * `run_python` call in a production build unable to start its worker —
 * silently, since nothing but a live call ever spawns one. So this finds the
 * chunk by what it contains rather than where it is expected to be, and FAILS
 * the build when it finds none: a refactor that renames the file or changes how
 * the URL is written should break here, not in production.
 *
 * Plain .mjs importing nothing outside node: builtins, like changelog.mjs.
 */

import { copyFileSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import process from 'node:process';

const SERVER_DIR = 'build/server';
// `spawnUrl` is how Vite prints the starting line. Quote style is Vite's, not ours.
const WORKERS = [
	{
		what: 'The code interpreter',
		src: 'src/lib/server/code-interpreter/worker.js',
		name: 'worker.js',
		spawnUrl: /new URL\(\s*["']\.\/worker\.js["']\s*,\s*import\.meta\.url\s*\)/,
		owner: 'pool.ts',
	},
	{
		what: "fetch_url's HTML extraction",
		src: 'src/lib/server/tools/fetch-extract-worker.js',
		name: 'fetch-extract-worker.js',
		spawnUrl: /new URL\(\s*["']\.\/fetch-extract-worker\.js["']\s*,\s*import\.meta\.url\s*\)/,
		owner: 'extract-in-worker.ts',
	},
];

const sources = readdirSync(SERVER_DIR, { recursive: true })
	.filter((f) => f.endsWith('.js'))
	.map((f) => join(SERVER_DIR, f))
	.map((f) => ({ f, text: readFileSync(f, 'utf8') }));

let failed = false;
for (const w of WORKERS) {
	const chunks = sources.filter(({ text }) => w.spawnUrl.test(text)).map(({ f }) => f);
	if (chunks.length === 0) {
		console.error(
			`place-worker: no chunk under ${SERVER_DIR} contains new URL('./${w.name}', import.meta.url).\n` +
				`${w.what} could not start its worker from this build. If ${w.owner} changed ` +
				'how it resolves the worker, update this script to match.',
		);
		failed = true;
		continue;
	}
	// Normally exactly one, but more is harmless: each gets its own copy.
	for (const dir of new Set(chunks.map((f) => dirname(f)))) {
		copyFileSync(w.src, join(dir, w.name));
		console.log(`place-worker: ${w.src} -> ${relative('.', join(dir, w.name))}`);
	}
}
if (failed) process.exit(1);
