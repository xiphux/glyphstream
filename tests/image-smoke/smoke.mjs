/**
 * Runs INSIDE the built runtime image (mounted into /app, so imports resolve
 * against the image's own production node_modules). CI's "Docker image smoke"
 * job executes it after the container has booted and served a page.
 *
 * What only this can catch: the image installs `--prod --ignore-scripts` on
 * Alpine/musl, while every other CI job runs a full dev install on glibc. A
 * runtime dependency that isn't in `dependencies`, a musl prebuilt that fails to
 * load (sharp's @img/sharp-linuxmusl-*), or a package whose entry point moved
 * would pass unit and e2e and break the shipped image. Each check does a small
 * piece of REAL work with the library, not just an import.
 *
 * Only three packages still live in node_modules: sharp, pyodide and shiki,
 * the ones that load files from their own directory at runtime (a native
 * binary, a WASM + stdlib bundle, lazily-imported grammars). Everything else
 * is a devDependency that adapter-node bundles into build/server, so there is
 * no package left to import here — and what can break changes shape. The
 * failure is now a bare import the bundler left external to a package the
 * image doesn't have, which every other job hides, because they run with the
 * full dev install. `bundle` catches that; the bundled libraries' BEHAVIOUR
 * is e2e's to cover, since Playwright runs this same production build.
 */
import { copyFileSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { fork, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Chunks whose evaluation IS the app, so importing them here would start a
// second instance inside the running container, on the same DB: adapter-node's
// handler calls `server.init`, which runs hooks.server's startup (sweepers, MCP
// bootstrap, model listing), and its entry listens on the port the container's
// server already holds. The code interpreter's worker refuses to load except
// as a forked child with an IPC channel (codeInterpreter below starts it so). All of them are still proven by run.sh, whose server can't
// boot and answer /api/health unless they load.
//
// adapter-node 6 moved its own server code into build/server (it used to sit
// beside it), under fixed names — and hooks.server went from a hashed chunk to
// entries/. A name this list misses gets imported: the last time, that was the
// listener (EADDRINUSE on :3000) and a second set of sweepers on the live DB.
const SKIP = [
	/\/server\/adapter-index\.js$/, // listens on PORT, installs signal handlers
	/\/server\/adapter-node-handler\.js$/, // calls server.init
	/\/server\/handler\.js$/, // re-exports the handler above
	/\/hooks\.server(\.js-[^/]*)?\.js$/, // entries/hooks.server.js (kit 3)
	/\/worker\.js$/,
];

const checks = {
	// The image runs as the unprivileged `node` user (see the Dockerfile's
	// USER). smoke.mjs runs via `docker exec`, which uses the image's user too,
	// so this fails if the USER line is dropped.
	async nonRoot() {
		const uid = process.getuid?.();
		if (uid === 0) throw new Error('running as root');
	},

	async bundle() {
		const root = '/app/build/server';
		const files = readdirSync(root, { recursive: true })
			.filter((f) => f.endsWith('.js'))
			.map((f) => join(root, f))
			.filter((f) => !SKIP.some((re) => re.test(f)));
		const problems = [];
		for (const f of files) {
			// ANY error fails, not only a missing module: with the app's own
			// entry points skipped, nothing left has a reason to throw at import,
			// and a bundler's CJS-interop mistake surfaces as a TypeError here.
			try {
				await import(f);
			} catch (e) {
				problems.push(`${f}: ${e instanceof Error ? e.message.split('\n')[0] : String(e)}`);
			}
		}
		// The operator scripts are esbuild bundles with their own externals list
		// (package.json's `build`). `--help` exits before either opens the DB,
		// and ESM links every static import before any code runs, so a missing
		// package still fails first. Not no arguments: faststart-backfill has no
		// usage error to stop at, and would run a real backfill on this DB.
		for (const script of ['import-owui.js', 'faststart-backfill.js']) {
			const r = spawnSync(process.execPath, [join('/app/build/scripts', script), '--help'], {
				encoding: 'utf8',
			});
			// Both exit 0 on --help, so any other outcome is a failure — including
			// esbuild's own "Dynamic require of … is not supported", which a CJS
			// package bundled as ESM throws at init.
			if (r.error || r.status !== 0) {
				const line = r.stderr?.split('\n').find((l) => /Error/.test(l));
				problems.push(`${script}: ${line ?? r.error?.message ?? `exit ${r.status}`}`);
			}
		}
		if (problems.length) throw new Error(`\n  ${problems.join('\n  ')}`);
		if (files.length < 50) throw new Error(`only ${files.length} server chunks found`);
	},

	async sharp() {
		const { default: sharp } = await import('sharp');
		const png = await sharp({
			create: { width: 64, height: 32, channels: 3, background: '#7c3aed' },
		})
			.png()
			.toBuffer();
		const jpeg = await sharp(png).resize({ width: 16 }).jpeg({ mozjpeg: true }).toBuffer();
		const meta = await sharp(jpeg).metadata();
		if (meta.format !== 'jpeg' || meta.width !== 16) {
			throw new Error(`unexpected vision variant: ${meta.format} ${meta.width}px`);
		}
		// Gallery thumbnails and display variants are WebP.
		const webp = await sharp(png).resize({ width: 16 }).webp({ quality: 60, effort: 6 }).toBuffer();
		const webpMeta = await sharp(webp).metadata();
		if (webpMeta.format !== 'webp' || webpMeta.width !== 16) {
			throw new Error(`unexpected thumbnail: ${webpMeta.format} ${webpMeta.width}px`);
		}
	},

	async pyodide() {
		const { loadPyodide } = await import('pyodide');
		const py = await loadPyodide();
		const out = py.runPython('sum(range(10))');
		if (out !== 45) throw new Error(`runPython returned ${String(out)}`);
	},

	// The code interpreter as the server starts it: a child process forked at
	// the URL the pool's chunk resolves (not a path this test assumes), under
	// the same permission flags spawn.ts uses. The URL is relative to wherever
	// the bundler put the chunk, and adapter-node moving the chunk once left
	// every production build without a worker to start (see
	// scripts/place-worker.mjs) while `pyodide` above still passed. The flags
	// matter too: a read grant that no longer covers what the worker loads in
	// the image fails here and nowhere else.
	async codeInterpreter() {
		const root = '/app/build/server';
		const spawner = readdirSync(root, { recursive: true })
			.filter((f) => f.endsWith('.js'))
			.map((f) => join(root, f))
			.find((f) =>
				/new URL\(\s*["']\.\/worker\.js["']\s*,\s*import\.meta\.url\s*\)/.test(
					readFileSync(f, 'utf8'),
				),
			);
		if (!spawner) throw new Error('no server chunk spawns ./worker.js');
		const workerPath = fileURLToPath(new URL('./worker.js', pathToFileURL(spawner)));
		const pyodideDir = dirname(createRequire(import.meta.url).resolve('pyodide'));
		// Mirrors spawnInterpreterProcess in src/lib/server/code-interpreter/spawn.ts.
		const child = fork(workerPath, [], {
			execArgv: [
				'--permission',
				`--allow-fs-read=${workerPath}`,
				`--allow-fs-read=${pyodideDir}`,
				'--max-old-space-size=512',
			],
			env: {},
			serialization: 'advanced',
			stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
		});
		try {
			const result = await new Promise((resolve, reject) => {
				const timer = setTimeout(() => reject(new Error('no result within 60s')), 60_000);
				child.on('error', (e) => {
					clearTimeout(timer);
					reject(e);
				});
				// A worker that dies without replying would otherwise surface as
				// the 60s timeout rather than its exit code. After a settle, the
				// `finally` below kills it and this reject is a no-op.
				child.on('exit', (code, signal) => {
					clearTimeout(timer);
					reject(new Error(`worker exited (${code ?? signal}) before replying`));
				});
				child.on('message', (m) => {
					if (m.type === 'ready') {
						child.send({ type: 'run', callId: 1, code: '6 * 7', preFiles: [] });
					} else {
						clearTimeout(timer);
						if (m.type === 'result') resolve(m.result);
						else reject(new Error(`worker replied ${JSON.stringify(m)}`));
					}
				});
				child.send({
					type: 'init',
					pyodideModuleUrl: pathToFileURL(join(pyodideDir, 'pyodide.mjs')).href,
				});
			});
			if (result !== 42) throw new Error(`6 * 7 returned ${JSON.stringify(result)}`);
		} finally {
			child.kill('SIGKILL');
		}
	},

	// A HEIC upload as the upload route converts it: copied into a fresh
	// directory under the OS temp dir (which must be writable by the image's
	// user), then decoded by the image's ffmpeg with media/heic.ts's arguments.
	// The sample is tiled and flagged to display rotated, so a portrait result
	// means both the tile stitching and the rotation work in the shipped binary.
	async heic() {
		const { default: sharp } = await import('sharp');
		const dir = mkdtempSync(join(tmpdir(), 'gs-heic-'));
		try {
			const src = join(dir, 'in.heic');
			const out = join(dir, 'out.jpg');
			copyFileSync(join(dirname(fileURLToPath(import.meta.url)), 'tiled-rotated.heic'), src);
			// Mirrors convertHeicToJpeg in src/lib/server/media/heic.ts.
			const r = spawnSync(
				'ffmpeg',
				[
					...['-hide_banner', '-loglevel', 'error', '-nostdin', '-threads', '1'],
					...['-max_pixels', '100000000', '-protocol_whitelist', 'file', '-i', src],
					...['-frames:v', '1', '-q:v', '2', '-f', 'image2', '-y', out],
				],
				{ encoding: 'utf8' },
			);
			if (r.error || r.status !== 0) {
				throw new Error(`ffmpeg: ${r.stderr?.trim() || r.error?.message || `exit ${r.status}`}`);
			}
			const meta = await sharp(out).metadata();
			if (meta.width !== 768 || meta.height !== 1024) {
				throw new Error(`converted to ${meta.width}x${meta.height}, expected 768x1024`);
			}
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	},

	async shiki() {
		const { createHighlighter } = await import('shiki');
		const hl = await createHighlighter({ themes: ['github-dark'], langs: ['python'] });
		const html = hl.codeToHtml('print(1)', { lang: 'python', theme: 'github-dark' });
		if (!html.includes('class="shiki')) throw new Error('no shiki markup');
	},
};

let failed = 0;
for (const [name, run] of Object.entries(checks)) {
	const started = Date.now();
	try {
		await run();
		console.log(`ok   ${name} (${Date.now() - started}ms)`);
	} catch (e) {
		failed++;
		console.log(`FAIL ${name}: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
	}
}
if (failed > 0) {
	console.log(`${failed} check(s) failed`);
	process.exit(1);
}
console.log('all image checks passed');
