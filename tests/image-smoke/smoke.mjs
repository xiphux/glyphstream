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
import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import process from 'node:process';

// Chunks whose evaluation IS the app, so importing them here would start a
// second instance inside the running container, on the same DB: adapter-node's
// handler calls `server.init`, which runs hooks.server's startup (sweepers, MCP
// bootstrap, model listing). The code interpreter's worker refuses to load off
// a worker thread. All three are still proven by run.sh, whose server can't
// boot and answer /api/health unless they load.
const SKIP = [/\/handler-[^/]*\.js$/, /\/hooks\.server\.js-[^/]*\.js$/, /\/worker\.js$/];

const checks = {
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
			throw new Error(`unexpected thumbnail: ${meta.format} ${meta.width}px`);
		}
	},

	async pyodide() {
		const { loadPyodide } = await import('pyodide');
		const py = await loadPyodide();
		const out = py.runPython('sum(range(10))');
		if (out !== 45) throw new Error(`runPython returned ${String(out)}`);
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
