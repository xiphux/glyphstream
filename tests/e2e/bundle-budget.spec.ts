/**
 * Client bundle budget, measured on the production build the e2e server runs.
 *
 * There is no fixed byte ceiling (CLAUDE.md: growth needs a reason, measured
 * with `pnpm analyze`). What this enforces is that growth is *seen*: the gzipped
 * initial load of the chat and home routes may not grow past the committed
 * baseline by more than a small tolerance. A dependency bump or a new static
 * import that adds weight fails here, and raising the baseline is then a
 * deliberate, reviewable change:
 *
 *   UPDATE_BUNDLE_BASELINE=1 pnpm exec playwright test bundle-budget --project=chromium-desktop
 *
 * "Initial load" is what the browser fetches to render the route cold: Kit's
 * entry (start + app), the root and (app) layout nodes, the page node, every
 * chunk they import statically, and the CSS those chunks carry. Dynamic imports
 * (shiki, markdown-it, pyodide's client bits) are excluded — they're route-lazy
 * by design, and the all-chunks total isn't the metric.
 *
 * It also guards the client shiki subset CLAUDE.md pins: no oniguruma WASM
 * engine, and no grammar beyond python + markdown, anywhere in the client build.
 */
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import process from 'node:process';
import { test, expect } from './fixtures/test';

const CLIENT_DIR = resolve('./build/client');
const MANIFEST = resolve('./.svelte-kit/output/client/.vite/manifest.json');
const APP_JS = resolve('./.svelte-kit/generated/client-optimized/app.js');
const BASELINE = resolve('./tests/e2e/fixtures/bundle-baseline.json');

/** Growth allowed before failing: 5%, but never less than 2 KB gzip, so a
 *  one-line change to a tiny route doesn't trip a percentage. */
const TOLERANCE_RATIO = 0.05;
const TOLERANCE_MIN_BYTES = 2048;

const BUDGETED_ROUTES = ['/(app)/chat/[id]', '/(app)'] as const;

/** The client grammars CLAUDE.md allows in the live-render subset. */
const ALLOWED_CLIENT_GRAMMARS = ['source.python', 'text.html.markdown'];

interface ManifestChunk {
	file: string;
	imports?: string[];
	css?: string[];
}
type Manifest = Record<string, ManifestChunk>;
interface RouteSize {
	js: number;
	css: number;
}

const gzipSize = (file: string): number => statSync(join(CLIENT_DIR, `${file}.gz`)).size;

/** Route id → the node indices Kit loads for it: the root layout (0), any
 *  layouts, and the page, parsed from the generated client dictionary. */
function routeNodes(routeId: string): number[] {
	const src = readFileSync(APP_JS, 'utf8');
	const escaped = routeId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	const m = new RegExp(`"${escaped}":\\s*\\[~?(\\d+)(?:,\\s*\\[([\\d,\\s]*)\\])?`).exec(src);
	if (!m) throw new Error(`route ${routeId} not found in ${APP_JS}`);
	const page = Number(m[1]);
	const layouts = (m[2] ?? '')
		.split(',')
		.map((s) => s.trim())
		.filter(Boolean)
		.map(Number);
	return [0, ...layouts, page];
}

function measureRoute(manifest: Manifest, routeId: string): RouteSize {
	const roots = [
		...Object.keys(manifest).filter(
			(k) => k.endsWith('/client-optimized/app.js') || k.endsWith('/runtime/client/entry.js'),
		),
		...routeNodes(routeId).map((n) => `.svelte-kit/generated/client-optimized/nodes/${n}.js`),
	];
	const seen = new Set<string>();
	const js = new Set<string>();
	const css = new Set<string>();
	const visit = (key: string) => {
		if (seen.has(key)) return;
		seen.add(key);
		const chunk = manifest[key];
		if (!chunk) throw new Error(`manifest has no entry for ${key}`);
		js.add(chunk.file);
		for (const c of chunk.css ?? []) css.add(c);
		for (const i of chunk.imports ?? []) visit(i);
	};
	roots.forEach(visit);
	const sum = (files: Set<string>) => [...files].reduce((n, f) => n + gzipSize(f), 0);
	return { js: sum(js), css: sum(css) };
}

function clientFiles(dir = CLIENT_DIR): string[] {
	return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
		const full = join(dir, e.name);
		return e.isDirectory() ? clientFiles(full) : [full];
	});
}

test.describe('client bundle', () => {
	test.skip(({ isMobile }) => isMobile, 'build output is the same for every project');

	test.beforeAll(() => {
		if (!existsSync(MANIFEST) || !existsSync(APP_JS) || !existsSync(CLIENT_DIR)) {
			throw new Error('No production build found — the e2e webServer runs `pnpm build` first.');
		}
	});

	test('initial route load stays within the committed baseline', () => {
		const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8')) as Manifest;
		const current = Object.fromEntries(
			BUDGETED_ROUTES.map((r) => [r, measureRoute(manifest, r)]),
		) as Record<string, RouteSize>;

		if (process.env.UPDATE_BUNDLE_BASELINE) {
			writeFileSync(BASELINE, JSON.stringify(current, null, '\t') + '\n');
			console.log(`bundle baseline written to ${BASELINE}:`, current);
			return;
		}

		const baseline = JSON.parse(readFileSync(BASELINE, 'utf8')) as Record<string, RouteSize>;
		const report: string[] = [];
		for (const route of BUDGETED_ROUTES) {
			for (const kind of ['js', 'css'] as const) {
				const was = baseline[route]?.[kind];
				const now = current[route][kind];
				if (was === undefined) {
					report.push(`${route} ${kind}: no baseline (now ${now} B)`);
					continue;
				}
				const allowed = was + Math.max(was * TOLERANCE_RATIO, TOLERANCE_MIN_BYTES);
				if (now > allowed) {
					report.push(
						`${route} ${kind}: ${now} B gzip, baseline ${was} B (+${(((now - was) / was) * 100).toFixed(1)}%, allowed up to ${Math.round(allowed)} B)`,
					);
				}
			}
		}
		expect(
			report,
			'Initial client load grew past the baseline. If the growth is justified, re-run with ' +
				'UPDATE_BUNDLE_BASELINE=1 and commit tests/e2e/fixtures/bundle-baseline.json with the reason.',
		).toEqual([]);
	});

	test('the client build carries no oniguruma WASM and only the allowed grammars', () => {
		const files = clientFiles().filter((f) => !f.endsWith('.gz') && !f.endsWith('.br'));

		expect(files.filter((f) => f.endsWith('.wasm'))).toEqual([]);

		const grammars = new Set<string>();
		const wasmInlined: string[] = [];
		for (const f of files.filter((f) => f.endsWith('.js'))) {
			const src = readFileSync(f, 'utf8');
			for (const m of src.matchAll(/"?scopeName"?:\s*"((?:source|text)\.[\w.-]+)"/g)) {
				grammars.add(m[1]);
			}
			// A base64-inlined WASM module starts "AGFzbQ" (\0asm); shiki's
			// engine-oniguruma ships its binary that way.
			if (src.includes('AGFzbQ')) wasmInlined.push(f);
		}
		expect(wasmInlined, 'inlined WASM in client chunks').toEqual([]);
		expect([...grammars].sort()).toEqual([...ALLOWED_CLIENT_GRAMMARS].sort());
	});
});
